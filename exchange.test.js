import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { create_app } from "./app.js";
import { hash } from "./inference/contracts.js";
import { LocalStore } from "./inference/storage.js";
import { InferenceService } from "./inference/service.js";
import { ExchangeStore } from "./exchange/storage.js";
import {
  record_bytes,
  parse_record,
  manifest_contract,
} from "./exchange/contracts.js";
import {
  collect_metadata,
  empty_metadata,
  metadata_contract,
} from "./exchange/metadata.js";
import { synchronize } from "./exchange/sync.js";
import { generate_identity } from "./peers/identity.js";
import { validate_trust } from "./peers/configuration.js";
import { create_peer_server } from "./peers/server.js";
import { peer_request } from "./peers/client.js";
import { PeerError, write_json } from "./peers/files.js";
import { PeerRuntime } from "./peers/runtime.js";

const [a, b, c] = await Promise.all([
  generate_identity(),
  generate_identity(),
  generate_identity(),
]);
const payload = (cpu = 20) => ({
  contract_version: 1,
  operation: "assess_performance",
  request_created_at: Date.now() - 1000,
  completed_at: Date.now(),
  input: {
    cpu_percent: cpu,
    available_memory_mib: 8000,
    queue_depth: 0,
    failure_percent: 0,
    p95_latency_ms: 100,
  },
  result: {
    contract_version: 1,
    operation: "assess_performance",
    output: { severity: "normal", reason: "normal", recommendation: "observe" },
    provenance: {
      engine: "ollama",
      engine_version: "0.40.14",
      model_digest: "a".repeat(64),
      template_version: 1,
      schema_version: 1,
      profile_version: 1,
      temperature: 0,
      max_output_tokens: 256,
      context_tokens: 4096,
      cpu_threads: 2,
      usage: { input_tokens: 40, output_tokens: 20 },
      timings_ms: { total: 10, load: 1, input: 1, output: 8 },
    },
  },
});
const trust_entry = (
  identity,
  port = 3447,
  scopes = ["status:read", "artifacts:exchange"],
) => ({
  node_id: identity.node_id,
  certificate: identity.certificate,
  endpoint: `https://127.0.0.1:${port}`,
  inbound_scopes: scopes,
  outbound_scopes: scopes,
  revoked: false,
});
const trust = (identity, entries) =>
  validate_trust({ contract_version: 1, peers: entries }, identity.node_id);
const temp = (t, dispose = () => {}) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "fracto-exchange-test-"),
  );
  t.after(async () => {
    await dispose();
    assert.equal(
      path.dirname(path.resolve(directory)),
      path.resolve(os.tmpdir()),
    );
    assert.ok(path.basename(directory).startsWith("fracto-exchange-test-"));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
};
const store = (t, node_id = a.node_id, options) => {
  let active;
  const directory = temp(t, () => active?.close());
  active = new ExchangeStore(directory, node_id, options);
  return {
    get value() {
      return active;
    },
    directory,
    reopen: () => {
      active.close();
      active = new ExchangeStore(directory, node_id, options);
      return active;
    },
  };
};
const memory_transport =
  (remote) =>
  async ({ route }) => {
    if (route === "/peer/v1/artifacts/metadata")
      return { value: remote.metadata() };
    const manifest = /\/manifest\/([^/]+)\/(\d+)$/.exec(route);
    if (manifest) {
      try {
        return { value: remote.manifest(manifest[1], Number(manifest[2])) };
      } catch (error) {
        if (error.code === "RESNAPSHOT_REQUIRED")
          throw new PeerError(error.code);
        throw error;
      }
    }
    const digest = route.split("/").at(-1);
    return { bytes: remote.blob(digest) };
  };
const sync = (
  local,
  remote,
  id = a.node_id,
  request = memory_transport(remote),
) => synchronize({ store: local, identity: b, peer: { node_id: id }, request });
const wait_for = async (check, ms = 10000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) assert.fail("condition timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

test("canonical records exclude raw/private fields and reject hidden encodings or incompatible profiles", () => {
  const value = {
    ...payload(),
    origin: { node_id: a.node_id, epoch: randomUUID(), sequence: 1 },
  };
  const bytes = record_bytes(value);
  const expected = {
    digest: hash(bytes),
    size_bytes: bytes.length,
    origin: value.origin,
  };
  assert.equal(parse_record(bytes, expected).input.cpu_percent, 20);
  for (const patch of [
    { user: "private" },
    { contract_version: 2 },
    { input: { ...value.input, server_name: "private" } },
    { result: { ...value.result, text: "private" } },
    {
      result: {
        ...value.result,
        provenance: { ...value.result.provenance, profile_version: 2 },
      },
    },
  ])
    assert.throws(() => record_bytes({ ...value, ...patch }));
  const pretty = Buffer.from(JSON.stringify(value, null, 2));
  assert.throws(() =>
    parse_record(pretty, {
      ...expected,
      digest: hash(pretty),
      size_bytes: pretty.length,
    }),
  );
  assert.throws(
    () => parse_record(bytes, { ...expected, digest: "0".repeat(64) }),
    { code: "HASH_MISMATCH" },
  );
  const duplicate = Buffer.from(
    bytes
      .toString()
      .replace(
        '"operation":"assess_performance"',
        '"operation":"private","operation":"assess_performance"',
      ),
  );
  assert.throws(() =>
    parse_record(duplicate, {
      ...expected,
      digest: hash(duplicate),
      size_bytes: duplicate.length,
    }),
  );
});

test("metadata exchanges only bounded model digests and fixed profiles", async () => {
  const metadata = await collect_metadata({
    id: "ollama",
    health: async () => ({ version: "0.40.14-private" }),
    list_models: async () => [
      {
        id: "private-model",
        digest: "b".repeat(64),
        size_bytes: 1000,
        user: "private",
      },
    ],
  });
  assert.equal(metadata.models.length, 1);
  assert.doesNotMatch(JSON.stringify(metadata), /private|user|url|hostname/);
  assert.throws(() => metadata_contract({ ...metadata, user: "private" }));
  assert.deepEqual(await collect_metadata(null), empty_metadata());
});

test("bounded manifests, idempotent publication and pagination survive restart", (t) => {
  const fixture = store(t);
  const id = randomUUID();
  assert.equal(fixture.value.publish(id, payload()), true);
  assert.equal(fixture.value.publish(id, payload(50)), false);
  for (let i = 0; i < 5; i++) fixture.value.publish(randomUUID(), payload(i));
  const first = manifest_contract(fixture.value.manifest("start", 0), 0);
  assert.equal(first.entries.length, 4);
  assert.equal(first.has_more, true);
  fixture.reopen();
  const second = fixture.value.manifest(first.epoch, first.next_cursor);
  assert.equal(second.entries.length, 2);
  assert.equal(second.has_more, false);
  assert.equal(fixture.value.publish(id, payload()), false);
});

test("partial transfer resumes after restart without refetching or duplicating completed entries", async (t) => {
  const source = store(t).value;
  const target = store(t, b.node_id);
  source.publish(randomUUID(), payload());
  source.publish(randomUUID(), payload(30));
  const transport = memory_transport(source);
  let blobs = 0;
  await assert.rejects(
    sync(target.value, source, a.node_id, async (options) => {
      if (options.route.includes("/blob/") && ++blobs === 2)
        throw new PeerError("PEER_UNAVAILABLE");
      return transport(options);
    }),
    { code: "PEER_UNAVAILABLE" },
  );
  assert.equal(target.value.status().imported_records, 1);
  const checkpoint = target.value.cursor(a.node_id);
  assert.ok(checkpoint.cursor > 0);
  target.reopen();
  blobs = 0;
  await sync(target.value, source, a.node_id, async (options) => {
    if (options.route.includes("/blob/")) blobs++;
    return transport(options);
  });
  assert.equal(blobs, 1);
  assert.equal(target.value.status().imported_records, 2);
  await sync(target.value, source);
  assert.equal(target.value.status().imported_records, 2);
});

test("relays preserve origins and three-node loops cannot multiply records", async (t) => {
  const first = store(t, a.node_id).value;
  const second = store(t, b.node_id).value;
  const third = store(t, c.node_id).value;
  first.publish(randomUUID(), payload());
  await sync(second, first, a.node_id);
  await sync(third, second, b.node_id);
  const relayed = third.manifest("start", 0).entries[0];
  assert.equal(relayed.origin.node_id, a.node_id);
  assert.deepEqual(third.blob(relayed.digest), first.blob(relayed.digest));
  await sync(first, third, c.node_id);
  await sync(second, third, c.node_id);
  assert.equal(first.rows().length, 1);
  assert.equal(second.rows().length, 1);
  assert.equal(third.rows().length, 1);
  assert.equal(third.inspect(relayed.digest).trust, "untrusted_evidence");
  assert.equal(third.inspect(relayed.digest).received_from, b.node_id);
});

test("malformed and conflicting artifacts are quarantined as codes without retaining rejected content", async (t) => {
  const source = store(t).value;
  const target = store(t, b.node_id).value;
  source.publish(randomUUID(), payload());
  const entry = source.manifest("start", 0).entries[0];
  const transport = memory_transport(source);
  await sync(target, source, a.node_id, async (options) =>
    options.route.includes("/blob/")
      ? { bytes: Buffer.from("private invalid response") }
      : transport(options),
  );
  assert.equal(target.status().imported_records, 0);
  assert.equal(target.status().quarantined_records, 1);
  assert.equal(target.cursor(a.node_id).cursor, entry.sequence);
  assert.doesNotMatch(
    JSON.stringify(target.db.prepare("SELECT * FROM quarantine").all()),
    /private/,
  );
  target.reset_cursor(a.node_id);
  await sync(target, source);
  const different = {
    ...JSON.parse(source.blob(entry.digest)),
    input: { ...payload().input, cpu_percent: 90 },
  };
  const bytes = record_bytes(different);
  assert.throws(
    () =>
      target.import(
        a.node_id,
        { ...entry, digest: hash(bytes), size_bytes: bytes.length },
        bytes,
        source.manifest("start", 0).epoch,
      ),
    { code: "ORIGIN_CONFLICT" },
  );
  assert.equal(
    target.blob(entry.digest).equals(source.blob(entry.digest)),
    true,
  );
});

test("retention changes the catalog epoch and resnapshot preserves independent imported history", async (t) => {
  const source = store(t, a.node_id, { max_records: 1 }).value;
  const target = store(t, b.node_id).value;
  source.publish(randomUUID(), payload());
  await sync(target, source);
  const before = target.cursor(a.node_id);
  source.publish(randomUUID(), payload(80));
  source.maintain();
  assert.throws(() => source.manifest(before.epoch, before.cursor), {
    code: "RESNAPSHOT_REQUIRED",
  });
  assert.equal((await sync(target, source)).reset, true);
  await sync(target, source);
  assert.equal(target.status().imported_records, 2);
  assert.equal(source.rows().length, 1);
  assert.throws(
    () => source.manifest(source.settings().catalog_epoch, 999999),
    { code: "RESNAPSHOT_REQUIRED" },
  );
});

test("exclusive ownership, atomic-orphan cleanup and disk admission fail safely", (t) => {
  const fixture = store(t);
  assert.throws(() => new ExchangeStore(fixture.directory, a.node_id));
  fixture.value.min_disk_bytes = Number.MAX_SAFE_INTEGER;
  assert.throws(() => fixture.value.publish(randomUUID(), payload()), {
    code: "DISK_PRESSURE",
  });
  assert.equal(fixture.value.rows().length, 0);
  fixture.value.min_disk_bytes = 0;
  fixture.value.publish(randomUUID(), payload());
  const orphan = fixture.value.files.write(
    record_bytes({
      ...payload(),
      origin: { node_id: a.node_id, epoch: randomUUID(), sequence: 90 },
    }),
  );
  fs.writeFileSync(
    path.join(fixture.directory, "artifacts", "unrelated.keep"),
    "preserve",
  );
  fixture.reopen();
  assert.ok(
    !fs.existsSync(path.join(fixture.directory, "artifacts", `${orphan}.json`)),
  );
  assert.ok(
    fs.existsSync(path.join(fixture.directory, "artifacts", "unrelated.keep")),
  );
});

test("real mTLS artifact transfer requires the artifact scope and never exposes local inference or credentials", async (t) => {
  const source = store(t).value;
  const target = store(t, b.node_id).value;
  source.publish(randomUUID(), payload());
  let peers = trust(a, [trust_entry(b)]);
  const transport = create_peer_server({
    identity: a,
    get_peers: () => peers,
    get_exchange: () => source,
  });
  transport.server.listen(0, "127.0.0.1");
  await once(transport.server, "listening");
  t.after(() => {
    transport.disconnect();
    return new Promise((resolve) => transport.server.close(resolve));
  });
  const peer = trust(b, [trust_entry(a, transport.server.address().port)])[0];
  await synchronize({ store: target, identity: b, peer });
  assert.equal(target.status().imported_records, 1);
  assert.equal(target.inventories().peers.length, 1);
  peers = trust(a, [trust_entry(b, 3447, ["status:read"])]);
  await assert.rejects(synchronize({ store: target, identity: b, peer }), {
    code: "SCOPE_DENIED",
  });
  await assert.rejects(
    peer_request({
      identity: b,
      peer,
      route: "/peer/v1/artifacts/blob/../../identity.json",
    }),
    { code: "PEER_PROTOCOL_ERROR" },
  );
});

test("invalid manifests and cancellation cannot advance durable progress or retain unsafe bodies", async (t) => {
  const source = store(t).value;
  const target = store(t, b.node_id).value;
  source.publish(randomUUID(), payload());
  const transport = memory_transport(source);
  await assert.rejects(
    sync(target, source, a.node_id, async (options) => {
      const result = await transport(options);
      if (options.route.endsWith("/metadata"))
        result.value.private = "identity";
      return result;
    }),
    { code: "INVALID_METADATA" },
  );
  assert.equal(target.inventories().peers.length, 0);
  await assert.rejects(
    sync(target, source, a.node_id, async (options) => {
      const result = await transport(options);
      if (options.route.includes("/manifest/"))
        result.value.private = "identity";
      return result;
    }),
    { code: "INVALID_MANIFEST" },
  );
  assert.equal(target.cursor(a.node_id).epoch, "start");
  const controller = new AbortController();
  await assert.rejects(
    synchronize({
      store: target,
      identity: b,
      peer: { node_id: a.node_id },
      signal: controller.signal,
      request: async (options) => {
        const result = await transport(options);
        if (options.route.includes("/blob/")) controller.abort();
        return result;
      },
    }),
    { code: "SYNC_CANCELLED" },
  );
  assert.equal(target.status().imported_records, 0);
  assert.equal(target.cursor(a.node_id).cursor, 0);
  for (let i = 0; i < 110; i++)
    target.quarantine(a.node_id, "INVALID_ARTIFACT");
  assert.equal(target.status().quarantined_records, 100);
});

const inference = (t) => {
  let service;
  const directory = temp(t, () => service?.close());
  const adapter = {
    id: "ollama",
    model: "private-model:latest",
    status: async () => ({ state: "ready" }),
    health: async () => ({ version: "0.40.14" }),
    list_models: async () => [
      { id: "private-model:latest", digest: "a".repeat(64), size_bytes: 1000 },
    ],
    generate: async () => ({
      engine: "ollama",
      engine_version: "0.40.14",
      model_digest: "a".repeat(64),
      structured: payload().result.output,
      usage: { input_tokens: 40, output_tokens: 20 },
      text: "private provider response",
    }),
  };
  service = new InferenceService({
    store: new LocalStore(path.join(directory, "jobs")),
    adapter,
    free_memory: () => 16 * 1024 ** 3,
    poll_ms: 20,
  });
  return service;
};
const request = () => ({
  contract_version: 1,
  idempotency_key: randomUUID(),
  operation: "assess_performance",
  input: payload().input,
});

test("two runtimes automatically publish completed jobs and import for authenticated inspection; inference stays independent", async (t) => {
  const first_source = inference(t);
  const second_source = inference(t);
  const first_dir = temp(t);
  const second_dir = temp(t);
  write_json(path.join(first_dir, "identity.json"), a);
  write_json(path.join(second_dir, "identity.json"), b);
  const first = new PeerRuntime({
    directory: first_dir,
    settings: { host: "127.0.0.1", port: 0 },
    poll_ms: 50,
    source: () => first_source,
  });
  const second = new PeerRuntime({
    directory: second_dir,
    settings: { host: "127.0.0.1", port: 0 },
    poll_ms: 50,
    source: () => second_source,
  });
  let server;
  let first_closed = false;
  try {
    const accepted = await first_source.submit(request());
    await wait_for(
      () => first_source.inspect(accepted.job.request_id).state === "completed",
    );
    await wait_for(
      () =>
        first.state === "ready" &&
        second.state === "ready" &&
        !!first.exchange &&
        !!second.exchange,
    );
    write_json(path.join(first_dir, "trust.json"), {
      contract_version: 1,
      peers: [
        trust_entry(b, second.transport.server.address().port, [
          "artifacts:exchange",
        ]),
      ],
    });
    write_json(path.join(second_dir, "trust.json"), {
      contract_version: 1,
      peers: [
        trust_entry(a, first.transport.server.address().port, [
          "artifacts:exchange",
        ]),
      ],
    });
    await wait_for(() => second.exchange.store.status().imported_records === 1);
    assert.equal(second.exchange.status().synced_peers, 1);
    assert.equal(second_source.store.all().length, 0);
    const artifact = second.exchange.store.manifest("start", 0).entries[0];
    assert.doesNotMatch(
      second.exchange.store.blob(artifact.digest).toString(),
      /private|idempotency|messages|model":/,
    );
    server = create_app({
      inference: second_source,
      get_exchange: () => second.exchange,
    }).listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    const headers = { "x-fracto-ai-token": second_source.store.token };
    assert.equal(
      (await fetch(`${base}/inference/artifacts/blob/${artifact.digest}`))
        .status,
      401,
    );
    const response = await fetch(
      `${base}/inference/artifacts/blob/${artifact.digest}`,
      { headers },
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).trust, "untrusted_evidence");
    assert.equal(
      (await fetch(`${base}/inference/artifacts/inventories`, { headers }))
        .status,
      200,
    );
    await first.close();
    first_closed = true;
    const local = await second_source.submit(request());
    await wait_for(
      () => second_source.inspect(local.job.request_id).state === "completed",
    );
    assert.equal((await fetch(`${base}/readyz`)).status, 200);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await second.close();
    if (!first_closed) await first.close();
  }
});

test("disk pressure and failed publication leave cursors unchanged; corrupt local content disables exchange only", async (t) => {
  const source = store(t).value;
  const target = store(t, b.node_id);
  source.publish(randomUUID(), payload());
  target.value.min_disk_bytes = Number.MAX_SAFE_INTEGER;
  await assert.rejects(sync(target.value, source), { code: "DISK_PRESSURE" });
  assert.equal(target.value.cursor(a.node_id).cursor, 0);
  target.value.min_disk_bytes = 0;
  const insert = target.value.insert;
  target.value.insert = () => {
    throw new Error("private filesystem details");
  };
  await assert.rejects(sync(target.value, source), {
    code: "EXCHANGE_UNAVAILABLE",
  });
  target.value.insert = insert;
  target.reopen();
  assert.equal(target.value.cursor(a.node_id).cursor, 0);
  await sync(target.value, source);
  const entry = target.value.manifest("start", 0).entries[0];
  fs.writeFileSync(
    path.join(target.directory, "artifacts", `${entry.digest}.json`),
    "corrupt",
  );
  assert.throws(() => target.value.blob(entry.digest), {
    code: "EXCHANGE_UNAVAILABLE",
  });
  assert.equal(target.value.failed, true);
});
