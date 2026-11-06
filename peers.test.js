import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { create_app } from "./app.js";
import {
  certificate_info,
  generate_identity,
  load_identity,
  public_identity,
  validate_identity,
} from "./peers/identity.js";
import {
  endpoint_url,
  load_trust,
  validate_trust,
  listener_settings,
} from "./peers/configuration.js";
import { read_json, write_json } from "./peers/files.js";
import {
  create_peer_server,
  tls_settings,
  connection_status,
} from "./peers/server.js";
import { probe_peer, validate_status } from "./peers/client.js";
import { PeerRuntime, create_peer_runtime } from "./peers/runtime.js";
import { run_peer_command } from "./peers/cli.js";

const [a, b, stranger] = await Promise.all([
  generate_identity(),
  generate_identity(),
  generate_identity(),
]);
const entry = (identity, port = 3447, patch = {}) => ({
  node_id: identity.node_id,
  certificate: identity.certificate,
  endpoint: `https://127.0.0.1:${port}`,
  inbound_scopes: ["status:read"],
  outbound_scopes: ["status:read"],
  revoked: false,
  ...patch,
});
const trust = (identity, entries) =>
  validate_trust({ contract_version: 1, peers: entries }, identity.node_id);
const wait_for = async (condition) => {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail("condition timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};
const directory = (t) => {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "fracto-peer-test-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(value)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(value).startsWith("fracto-peer-test-"));
    fs.rmSync(value, { recursive: true, force: true });
  });
  return value;
};
const listening = async (t, configuration = {}) => {
  let peers = trust(b, [entry(a)]);
  const transport = create_peer_server({
    identity: b,
    get_peers: () => peers,
    ...configuration,
  });
  transport.server.listen(0, "127.0.0.1");
  await once(transport.server, "listening");
  t.after(() => {
    transport.disconnect();
    return new Promise((resolve) => transport.server.close(resolve));
  });
  const peer = trust(a, [entry(b, transport.server.address().port)])[0];
  return {
    ...transport,
    peer,
    set_peers: (value) => {
      peers = value;
      transport.disconnect();
      transport.server.setSecureContext(tls_settings(b, value));
    },
  };
};
const raw_request = ({
  identity = a,
  peer,
  route = "/peer/v1/status",
  headers = {},
  method = "GET",
}) =>
  new Promise((resolve, reject) => {
    const url = endpoint_url(peer.endpoint);
    const request = https.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: route,
        method,
        cert: identity?.certificate,
        key: identity?.private_key,
        ca: peer.certificate,
        minVersion: "TLSv1.3",
        servername: "",
        checkServerIdentity: () => undefined,
        agent: false,
        headers: { Host: "fracto-peer.invalid", ...headers },
      },
      (response) => {
        const chunks = [];
        response.on("data", (c) => chunks.push(c));
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString()),
          }),
        );
      },
    );
    request.on("error", reject);
    request.end();
  });

test("automatic identity persists, matches key and exports no private or host identity fields", async (t) => {
  const data = directory(t);
  const first = await load_identity(data);
  assert.deepEqual(await load_identity(data), first);
  validate_identity(first);
  assert.deepEqual(
    read_json(path.join(data, "enrollment.json")),
    public_identity(first),
  );
  assert.equal(load_trust(data, first.node_id).peers.length, 0);
  const info = certificate_info(first.certificate, first.node_id);
  assert.equal(info.certificate.subject, `CN=fracto-node-${first.node_id}`);
  assert.equal(
    info.certificate.subjectAltName,
    `URI:urn:fracto:node:${first.node_id}`,
  );
  assert.doesNotMatch(
    JSON.stringify(public_identity(first)),
    /private_key|PRIVATE KEY|endpoint|hostname|email/,
  );
  assert.throws(() =>
    validate_identity({ ...first, private_key: b.private_key }),
  );
});

test("allowlist rejects unknown fields, self/duplicate peers, unsafe endpoints and scopes", () => {
  for (const patch of [
    { node_id: b.node_id },
    { certificate: stranger.certificate },
    { inbound_scopes: ["admin"] },
    { outbound_scopes: ["status:read", "status:read"] },
    { revoked: "false" },
    { user: "private" },
  ])
    assert.throws(() => trust(b, [entry(a, 3447, patch)]));
  assert.throws(() => trust(b, [entry(a), entry(a)]));
  assert.throws(() =>
    trust(
      b,
      Array.from({ length: 17 }, () => entry(a)),
    ),
  );
  for (const url of [
    "http://127.0.0.1:3447",
    "file:///local",
    "https://user:secret@peer.invalid:3447",
    "https://peer.invalid:3447/api/chat",
    "https://peer.invalid:11434",
    "https://peer.invalid:3447?secret=x",
    "https://peer.invalid:3447/#x",
  ])
    assert.throws(() => endpoint_url(url));
  assert.throws(() => listener_settings({ FRACTO_AI_PEER_PORT: "11434" }));
  assert.throws(() =>
    validate_status(
      { ...connection_status(b), private: "identity" },
      b.node_id,
    ),
  );
  assert.throws(() => validate_status(connection_status(b), stranger.node_id));
});

test("configured peers connect with mutual TLS 1.3 and a fixed non-identifying request", async (t) => {
  const target = await listening(t);
  const protocols = [];
  target.server.on("secureConnection", (socket) =>
    protocols.push(socket.getProtocol()),
  );
  const summary = await probe_peer({ identity: a, peer: target.peer });
  assert.equal(protocols[0], "TLSv1.3");
  assert.deepEqual(summary, {
    contract_version: 1,
    status: "ready",
    capabilities: { status: true, artifacts: false, delegation: false },
  });
  assert.doesNotMatch(
    JSON.stringify(summary),
    /node_id|certificate|endpoint|127\.0\.0\.1|private_key/,
  );
  assert.equal((await raw_request({ peer: target.peer })).status, 200);
});

test("unknown certificates, absent credentials, revoked peers and local bearer tokens are rejected", async (t) => {
  const target = await listening(t);
  await assert.rejects(probe_peer({ identity: stranger, peer: target.peer }), {
    code: "PEER_UNAVAILABLE",
  });
  await assert.rejects(raw_request({ identity: null, peer: target.peer }));
  assert.equal(
    (
      await raw_request({
        peer: target.peer,
        headers: { "x-fracto-ai-token": "a".repeat(64) },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await raw_request({
        peer: target.peer,
        headers: { cookie: "private-session=value" },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await raw_request({
        peer: target.peer,
        headers: { origin: "http://browser.invalid" },
      })
    ).status,
    400,
  );
  target.set_peers(trust(b, [entry(a, 3447, { revoked: true })]));
  await assert.rejects(probe_peer({ identity: a, peer: target.peer }), {
    code: "PEER_UNAVAILABLE",
  });
});

test("inbound and outbound scopes are independent and future operations cannot run", async (t) => {
  const target = await listening(t);
  target.set_peers(
    trust(b, [entry(a, 3447, { inbound_scopes: ["artifacts:exchange"] })]),
  );
  await assert.rejects(probe_peer({ identity: a, peer: target.peer }), {
    code: "SCOPE_DENIED",
  });
  await assert.rejects(
    probe_peer({ identity: a, peer: { ...target.peer, outbound_scopes: [] } }),
    { code: "SCOPE_DENIED" },
  );
  for (const route of [
    "/peer/v1/artifacts",
    "/peer/v1/delegate",
    "/inference/jobs",
    "/api/chat",
    "/peer/v1/status?path=private",
    "/peer/v1/../../identity.json",
  ]) {
    assert.equal((await raw_request({ peer: target.peer, route })).status, 404);
  }
});

test("certificate rotation rejects the old pin in both directions", async (t) => {
  const target = await listening(t);
  const replacement = await generate_identity(a.node_id);
  target.set_peers(trust(b, [entry(replacement)]));
  await assert.rejects(probe_peer({ identity: a, peer: target.peer }), {
    code: "PEER_UNAVAILABLE",
  });
  assert.equal(
    (await probe_peer({ identity: replacement, peer: target.peer })).status,
    "ready",
  );
  const wrong_server = await generate_identity(b.node_id);
  const pinned_wrong = trust(a, [
    entry(wrong_server, target.server.address().port),
  ])[0];
  await assert.rejects(
    probe_peer({ identity: replacement, peer: pinned_wrong }),
    { code: "PEER_UNAVAILABLE" },
  );
});

test("expiry and transport tampering fail closed; no redirect, oversized or private response is accepted", async (t) => {
  assert.throws(() =>
    certificate_info(a.certificate, a.node_id, Date.now() + 367 * 86400000),
  );
  let behavior = "redirect";
  let redirected = false;
  const server = https
    .createServer(tls_settings(b, trust(b, [entry(a)])), (req, res) => {
      assert.equal(req.headers.host, "fracto-peer.invalid");
      assert.equal(req.headers.authorization, undefined);
      if (req.url !== "/peer/v1/status") redirected = true;
      res.setHeader("Content-Type", "application/json");
      if (behavior === "redirect") {
        res.writeHead(302, { Location: "/private-target" });
        res.end("{}");
      }
      if (behavior === "oversized")
        res.end(JSON.stringify({ text: "x".repeat(5000) }));
      if (behavior === "private")
        res.end(JSON.stringify({ ...connection_status(b), email: "private" }));
      if (behavior === "stall") res.write("{");
    })
    .listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const peer = trust(a, [entry(b, server.address().port)])[0];
  for (behavior of ["redirect", "oversized", "private"])
    await assert.rejects(probe_peer({ identity: a, peer }), {
      code: "PEER_PROTOCOL_ERROR",
    });
  behavior = "stall";
  await assert.rejects(probe_peer({ identity: a, peer, timeout_ms: 100 }), {
    code: "PEER_DEADLINE_EXCEEDED",
  });
  assert.equal(redirected, false);
});

test("per-peer request rate is bounded", async (t) => {
  const target = await listening(t);
  const statuses = [];
  for (let i = 0; i < 12; i++)
    statuses.push((await raw_request({ peer: target.peer })).status);
  assert.ok(statuses.includes(429));
});

test("local enrollment verifies an external fingerprint; rotation/revocation are atomic", async (t) => {
  const data = directory(t);
  const identity = await load_identity(data);
  const bundle = path.join(data, "approved-peer.json");
  write_json(bundle, public_identity(a));
  await assert.rejects(
    run_peer_command(
      ["enroll", bundle, "https://127.0.0.1:3447", "wrong-pin"],
      data,
    ),
  );
  const fingerprint = certificate_info(a.certificate, a.node_id).fingerprint;
  await run_peer_command(
    ["enroll", bundle, "https://127.0.0.1:3447", fingerprint],
    data,
  );
  assert.equal(load_trust(data, identity.node_id).peers[0].revoked, false);
  await run_peer_command(["revoke", a.node_id], data);
  assert.equal(load_trust(data, identity.node_id).peers[0].revoked, true);
  await run_peer_command(["rotate"], data);
  const rotated = await load_identity(data);
  assert.equal(rotated.node_id, identity.node_id);
  assert.notEqual(rotated.certificate, identity.certificate);
  assert.notEqual(rotated.private_key, identity.private_key);
  assert.ok(!fs.existsSync(path.join(data, "admin.lock")));
});

test("runtime automatically reloads trust, probes and revokes without inference or MySQL", async (t) => {
  const data = directory(t);
  write_json(path.join(data, "identity.json"), b);
  write_json(path.join(data, "trust.json"), {
    contract_version: 1,
    peers: [entry(a)],
  });
  const runtime = new PeerRuntime({
    directory: data,
    settings: { host: "127.0.0.1", port: 0 },
    poll_ms: 50,
  });
  try {
    await wait_for(() => runtime.state === "ready");
    const peer = trust(a, [
      entry(b, runtime.transport.server.address().port),
    ])[0];
    assert.equal((await probe_peer({ identity: a, peer })).status, "ready");
    write_json(path.join(data, "trust.json"), {
      contract_version: 1,
      peers: [entry(a, 3447, { revoked: true })],
    });
    await wait_for(() => runtime.status().revoked_peers === 1);
    await assert.rejects(probe_peer({ identity: a, peer }), {
      code: "PEER_UNAVAILABLE",
    });
    fs.writeFileSync(
      path.join(data, "trust.json"),
      "malformed private configuration",
    );
    await wait_for(() => runtime.state === "unavailable");
    assert.equal(runtime.status().trusted_peers, 0);
    write_json(path.join(data, "trust.json"), {
      contract_version: 1,
      peers: [],
    });
    await wait_for(() => runtime.state === "ready");
  } finally {
    await runtime.close();
  }
});

test("public peer status is aggregate-only, failures preserve readiness and HTTP has no peer operations", async (t) => {
  const server = create_app({
    peer_status: () => ({
      state: "ready",
      trusted_peers: 2,
      reachable_peers: 1,
      node_id: "private-identity",
      endpoint: "private-url",
      certificate: "private-certificate",
      user: "private-user",
    }),
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const status = await (await fetch(`${base}/peers/status`)).json();
  assert.equal(status.trusted_peers, 2);
  assert.doesNotMatch(JSON.stringify(status), /private|endpoint|node_id|user/);
  assert.equal((await fetch(`${base}/peer/v1/status`)).status, 404);
  assert.equal((await fetch(`${base}/readyz`)).status, 200);
  const disabled = create_peer_runtime({ FRACTO_AI_PEERS_ENABLED: "false" });
  assert.equal(disabled.status().state, "disabled");
  const invalid = create_peer_runtime({ FRACTO_AI_PEER_PORT: "invalid" });
  assert.equal(invalid.status().state, "unavailable");
});

test("two independent runtimes automatically establish authenticated reachability in both directions", async (t) => {
  const first_dir = directory(t);
  const second_dir = directory(t);
  write_json(path.join(first_dir, "identity.json"), a);
  write_json(path.join(second_dir, "identity.json"), b);
  const first = new PeerRuntime({
    directory: first_dir,
    settings: { host: "127.0.0.1", port: 0 },
    poll_ms: 50,
    probe_interval_ms: 1000,
  });
  const second = new PeerRuntime({
    directory: second_dir,
    settings: { host: "127.0.0.1", port: 0 },
    poll_ms: 50,
    probe_interval_ms: 1000,
  });
  try {
    await wait_for(() => first.state === "ready" && second.state === "ready");
    write_json(path.join(first_dir, "trust.json"), {
      contract_version: 1,
      peers: [entry(b, second.transport.server.address().port)],
    });
    write_json(path.join(second_dir, "trust.json"), {
      contract_version: 1,
      peers: [entry(a, first.transport.server.address().port)],
    });
    await wait_for(
      () =>
        first.status().reachable_peers === 1 &&
        second.status().reachable_peers === 1,
    );
    assert.equal(first.status().trusted_peers, 1);
    assert.equal(second.status().trusted_peers, 1);
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
});

test("expired trust can be revoked incrementally and an expired local identity can rotate", async (t) => {
  const data = directory(t);
  const own = await load_identity(data);
  const old_time = Date.now() - 366 * 86400000;
  const [expired_a, expired_b] = await Promise.all([
    generate_identity(a.node_id, old_time),
    generate_identity(b.node_id, old_time),
  ]);
  write_json(path.join(data, "trust.json"), {
    contract_version: 1,
    peers: [entry(expired_a), entry(expired_b)],
  });
  assert.throws(() => load_trust(data, own.node_id));
  await run_peer_command(["revoke", a.node_id], data);
  assert.throws(() => load_trust(data, own.node_id));
  await run_peer_command(["revoke", b.node_id], data);
  assert.ok(load_trust(data, own.node_id).peers.every((peer) => peer.revoked));
  write_json(
    path.join(data, "identity.json"),
    await generate_identity(own.node_id, old_time),
  );
  await run_peer_command(["rotate"], data);
  validate_identity(await load_identity(data));
});

test("HTTP bind failure closes the peer runtime and exits rather than leaving a partial service alive", async (t) => {
  const data = directory(t);
  const occupied = net.createServer().listen(0, "127.0.0.1");
  const reservation = net.createServer().listen(0, "127.0.0.1");
  await Promise.all([
    once(occupied, "listening"),
    once(reservation, "listening"),
  ]);
  t.after(() => new Promise((resolve) => occupied.close(resolve)));
  const peer_port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(process.execPath, ["index.js"], {
    cwd: import.meta.dirname,
    env: {
      ...process.env,
      FRACTO_AI_DATA_DIR: data,
      FRACTO_AI_PEER_DATA_DIR: path.join(data, "peers"),
      FRACTO_AI_KNOWLEDGE_DIR: path.join(data, "knowledge"),
      FRACTO_AI_SKILL_DIR: path.join(data, "skills"),
      FRACTO_AI_PORT: String(occupied.address().port),
      FRACTO_AI_LISTEN_HOST: "127.0.0.1",
      FRACTO_AI_PEERS_ENABLED: "true",
      FRACTO_AI_PEER_PORT: String(peer_port),
      FRACTO_AI_PEER_LISTEN_HOST: "127.0.0.1",
      FRACTO_OLLAMA_ENABLED: "false",
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "",
    error_output = "",
    timeout_phase = null,
    shutdown_timer;
  const exited = once(child, "close");
  exited.catch(() => {});
  // Parallel cold startup includes durable knowledge/skill/identity initialization.
  // Once the bind error is observed, cleanup still has its own strict deadline.
  const startup_timer = setTimeout(() => {
    timeout_phase = "startup did not reach the occupied HTTP listener";
    child.kill("SIGKILL");
  }, 60000);
  child.stdout.on("data", (chunk) => {
    output = (output + chunk).slice(-65536);
  });
  child.stderr.on("data", (chunk) => {
    error_output = (error_output + chunk).slice(-65536);
    if (!shutdown_timer && /could not open its listener/.test(error_output)) {
      clearTimeout(startup_timer);
      shutdown_timer = setTimeout(() => {
        timeout_phase = "runtime cleanup did not exit after HTTP bind failure";
        child.kill("SIGKILL");
      }, 15000);
    }
  });
  t.after(async () => {
    clearTimeout(startup_timer);
    clearTimeout(shutdown_timer);
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await exited.catch(() => {});
  });
  const [code, signal] = await exited;
  clearTimeout(startup_timer);
  clearTimeout(shutdown_timer);
  assert.equal(
    timeout_phase,
    null,
    `${timeout_phase}\n${output}\n${error_output}`,
  );
  assert.equal(signal, null);
  assert.equal(code, 1);
  assert.match(error_output, /could not open its listener/);
  // No peer listener may survive the failed HTTP process.
  const reusable = net.createServer();
  await new Promise((resolve, reject) => {
    reusable.once("error", reject);
    reusable.listen(peer_port, "127.0.0.1", resolve);
  });
  await new Promise((resolve) => reusable.close(resolve));
});
