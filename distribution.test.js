import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { DistributionStore } from "./distribution/storage.js";
import {
  bytes_hash,
  encode,
  parse,
  page_contract,
} from "./distribution/contracts.js";
import { synchronize_distribution } from "./distribution/sync.js";
import { adopt_knowledge, adopt_skill } from "./distribution/adopt.js";
import { DistributionRuntime } from "./distribution/runtime.js";
import { KnowledgeStore } from "./knowledge/storage.js";
import { SkillRegistry } from "./skills/storage.js";
import { infrastructure_definition } from "./skills/builtin.js";
import { canonical, hash } from "./skills/contracts.js";
import { executor_digest } from "./skills/executor.js";
import { generate_identity } from "./peers/identity.js";
import { validate_trust } from "./peers/configuration.js";
import { create_peer_server } from "./peers/server.js";
import { peer_request } from "./peers/client.js";
import { PeerRuntime } from "./peers/runtime.js";
import { write_json } from "./peers/files.js";
import { create_app } from "./app.js";

const [a, b, c] = await Promise.all([
  generate_identity(),
  generate_identity(),
  generate_identity(),
]);
const knowledge = (
  text = "Terrain meshes belong to the tiles service.",
  source = "terrain",
  revision = "v1",
) => ({
  source,
  revision,
  text,
  content_digest: bytes_hash(Buffer.from(text)),
});
const skill = () => ({
  definition: structuredClone(infrastructure_definition),
  definition_digest: hash(canonical(infrastructure_definition)),
});
const resources = new WeakMap();
const dispose = (t, callback) => resources.get(t).callbacks.push(callback);
const temp = (t) => {
  if (!resources.has(t)) {
    const state = { directories: [], callbacks: [] };
    resources.set(t, state);
    t.after(async () => {
      for (const callback of state.callbacks.reverse()) await callback();
      for (const directory of state.directories.reverse()) {
        assert.equal(
          path.dirname(path.resolve(directory)),
          path.resolve(os.tmpdir()),
        );
        assert.ok(path.basename(directory).startsWith("fracto-distribution-"));
        fs.rmSync(directory, { recursive: true, force: true });
      }
    });
  }
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "fracto-distribution-"),
  );
  resources.get(t).directories.push(directory);
  return directory;
};
const fixture = (t, identity = a) => {
  const directory = temp(t),
    opened = [];
  const open = () => {
    const store = new DistributionStore(directory, identity.node_id);
    opened.push(store);
    return store;
  };
  const store = open();
  dispose(t, () => opened.forEach((item) => item.close()));
  return { store, directory, open };
};
const memory =
  (remote) =>
  async ({ route }) => {
    const parts = route.split("/"),
      kind = parts[4];
    const value =
      parts[5] === "manifest"
        ? remote.manifest(kind, parts[6], Number(parts[7]))
        : null;
    const bytes = value
      ? Buffer.from(JSON.stringify(value))
      : remote.blob(kind, parts[6]);
    return { value: value ?? JSON.parse(bytes), bytes };
  };
const entry = (
  identity,
  port,
  scopes = ["knowledge:exchange", "skills:exchange"],
) => ({
  node_id: identity.node_id,
  certificate: identity.certificate,
  endpoint: `https://127.0.0.1:${port}`,
  inbound_scopes: scopes,
  outbound_scopes: scopes,
  revoked: false,
});
const trust = (own, peers) =>
  validate_trust({ contract_version: 1, peers }, own.node_id);
const server = async (t, identity, store, peers) => {
  const transport = create_peer_server({
    identity,
    get_peers: () => peers,
    get_distribution: () => store,
  });
  transport.server.listen(0, "127.0.0.1");
  await once(transport.server, "listening");
  dispose(t, () => {
    transport.disconnect();
    return new Promise((resolve) => transport.server.close(resolve));
  });
  return transport.server.address().port;
};

test("publication is explicit, immutable/idempotent and survives catalog reopen", (t) => {
  const { store, open } = fixture(t);
  assert.equal(store.status().published, 0);
  const published = store.publish("knowledge", knowledge());
  assert.equal(
    store.publish("knowledge", knowledge()).digest,
    published.digest,
  );
  assert.equal(store.status().records, 1);
  assert.equal(store.status().published, 1);
  const bytes = store.blob("knowledge", published.digest);
  assert.equal(bytes_hash(bytes), published.digest);
  assert.deepEqual(parse(bytes), published.record);
  assert.throws(
    () => store.blob("skill", published.digest),
    /DISTRIBUTION_NOT_FOUND/,
  );
  store.close();
  assert.equal(
    open().get(published.digest).record.payload.text,
    knowledge().text,
  );
});

test("bounded pages resume after interrupted pulls and retain per-kind cursors", async (t) => {
  const source = fixture(t, a).store,
    target = fixture(t, b),
    peer = entry(a, 3447);
  for (let n = 0; n < 6; n++)
    source.publish("knowledge", knowledge(`terrain item ${n}`, `terrain-${n}`));
  source.publish("skill", skill());
  let blobs = 0;
  await assert.rejects(
    synchronize_distribution({
      store: target.store,
      identity: b,
      peer,
      kind: "knowledge",
      request: async (input) => {
        if (input.route.includes("/blob/") && ++blobs === 2)
          throw new Error("fixture offline");
        return memory(source)(input);
      },
    }),
  );
  assert.equal(target.store.status().records, 1);
  assert.equal(target.store.cursor(a.node_id, "knowledge").cursor, 1);
  target.store.close();
  const restored = target.open();
  await synchronize_distribution({
    store: restored,
    identity: b,
    peer,
    kind: "knowledge",
    request: memory(source),
  });
  await synchronize_distribution({
    store: restored,
    identity: b,
    peer,
    kind: "knowledge",
    request: memory(source),
  });
  assert.equal(restored.status().records, 6);
  await synchronize_distribution({
    store: restored,
    identity: b,
    peer,
    kind: "skill",
    request: memory(source),
  });
  assert.equal(restored.status().records, 7);
  assert.equal(restored.status().published, 0);
  assert.equal(restored.manifest("skill", "start", 0).entries.length, 0);
});

test("withdrawal invalidates the feed epoch without erasing imported candidates", async (t) => {
  const source = fixture(t, a).store,
    target = fixture(t, b).store,
    peer = entry(a, 3447);
  const item = source.publish("knowledge", knowledge());
  await synchronize_distribution({
    store: target,
    identity: b,
    peer,
    kind: "knowledge",
    request: memory(source),
  });
  source.withdraw(item.digest);
  assert.equal(source.status().published, 0);
  const reset = await synchronize_distribution({
    store: target,
    identity: b,
    peer,
    kind: "knowledge",
    request: memory(source),
  });
  assert.equal(reset.reset, true);
  assert.equal(target.get(item.digest).record.payload.source, "terrain");
  assert.throws(
    () => source.blob("knowledge", item.digest),
    /DISTRIBUTION_NOT_FOUND/,
  );
});

test("relays preserve origins, suppress loops and reject conflicting origin/content claims", async (t) => {
  const source = fixture(t, a).store,
    middle = fixture(t, b).store,
    last = fixture(t, c).store;
  const item = source.publish("knowledge", knowledge());
  await synchronize_distribution({
    store: middle,
    identity: b,
    peer: entry(a, 3447),
    kind: "knowledge",
    request: memory(source),
  });
  assert.equal(middle.status().published, 0);
  middle.relay(item.digest);
  await synchronize_distribution({
    store: last,
    identity: c,
    peer: entry(b, 3447),
    kind: "knowledge",
    request: memory(middle),
  });
  assert.deepEqual(last.get(item.digest).record.origin, item.record.origin);
  assert.equal(last.get(item.digest).immediate_sender, b.node_id);
  await synchronize_distribution({
    store: source,
    identity: a,
    peer: entry(b, 3447),
    kind: "knowledge",
    request: memory(middle),
  });
  assert.equal(source.status().records, 1);
  const changed = structuredClone(item.record);
  changed.payload = knowledge("different terrain");
  const bytes = encode(changed);
  assert.throws(
    () =>
      last.import(
        b.node_id,
        "knowledge",
        {
          digest: bytes_hash(bytes),
          bytes: bytes.length,
          origin: item.record.origin,
        },
        bytes,
      ),
    /ORIGIN_CONFLICT/,
  );
});

test("malformed bodies, manifests and hashes are quarantined without accepting content", async (t) => {
  const source = fixture(t, a).store,
    target = fixture(t, b).store,
    peer = entry(a, 3447);
  source.publish("knowledge", knowledge());
  await synchronize_distribution({
    store: target,
    identity: b,
    peer,
    kind: "knowledge",
    request: async (input) => {
      const result = await memory(source)(input);
      if (input.route.includes("/blob/")) result.bytes = Buffer.from("{}");
      return result;
    },
  });
  assert.equal(target.status().records, 0);
  assert.equal(target.status().quarantined, 1);
  target.reset(a.node_id, "knowledge");
  await assert.rejects(
    synchronize_distribution({
      store: target,
      identity: b,
      peer,
      kind: "knowledge",
      request: async () => ({ value: { private: "payload" } }),
    }),
    /INVALID_DISTRIBUTION/,
  );
  assert.equal(target.cursor(a.node_id, "knowledge").cursor, 0);
  assert.throws(
    () =>
      parse(
        Buffer.from(
          JSON.stringify({
            contract_version: 1,
            kind: "knowledge",
            origin: {},
            payload: {},
          }),
        ),
      ),
    /INVALID_DISTRIBUTION/,
  );
  const page = source.manifest("knowledge", "start", 0);
  page.entries[0].bytes = 196609;
  assert.throws(
    () => page_contract(page, "knowledge", 0),
    /INVALID_DISTRIBUTION_MANIFEST/,
  );
});

test("adoption cannot overwrite local knowledge and recovers after local commit before receipt", async (t) => {
  const source = fixture(t, a).store,
    target = fixture(t, b).store,
    item = source.publish("knowledge", knowledge());
  await synchronize_distribution({
    store: target,
    identity: b,
    peer: entry(a, 3447),
    kind: "knowledge",
    request: memory(source),
  });
  const local = new KnowledgeStore(path.join(temp(t), "knowledge"));
  dispose(t, () => local.close());
  local.put("terrain", "local-v1", "Local curated terrain");
  assert.throws(
    () => adopt_knowledge(target, item.digest, local, "terrain"),
    /CURRENT_REVISION_CONFLICT/,
  );
  adopt_knowledge(target, item.digest, local, "terrain", "local-v1");
  assert.equal(local.get("terrain").revision, `peer-${item.digest}`);
  const finish = target.finish_adoption.bind(target);
  target.finish_adoption = () => {
    throw new Error("fixture receipt failure");
  };
  assert.throws(
    () => adopt_knowledge(target, item.digest, local, "peer-terrain"),
    /fixture receipt failure/,
  );
  target.finish_adoption = finish;
  const receipt = adopt_knowledge(target, item.digest, local, "peer-terrain");
  assert.equal(local.get("peer-terrain").text, knowledge().text);
  assert.equal(receipt.immediate_sender, a.node_id);
  assert.equal(
    target.adoptions().find((item) => item.target === "knowledge:peer-terrain")
      .state,
    "completed",
  );
});

test("adopted skill is a local candidate with no imported evaluation or activation", async (t) => {
  const source = fixture(t, a).store,
    target = fixture(t, b).store,
    item = source.publish("skill", skill());
  await synchronize_distribution({
    store: target,
    identity: b,
    peer: entry(a, 3447),
    kind: "skill",
    request: memory(source),
  });
  const registry = new SkillRegistry(path.join(temp(t), "registry"));
  dispose(t, () => registry.close());
  const receipt = adopt_skill(target, item.digest, registry);
  assert.equal(receipt.activation_changed, false);
  assert.equal(
    registry.get("infrastructure-reference", "1.0.0").evaluation,
    null,
  );
  assert.throws(
    () => registry.resolve("infrastructure-reference", executor_digest()),
    /SKILL_DISABLED/,
  );
  const bad = skill();
  bad.definition.permissions = ["data:write"];
  bad.definition_digest = hash(canonical(bad.definition));
  assert.throws(() => source.publish("skill", bad), /INVALID_DISTRIBUTION/);
});

test("real mTLS distribution enforces independent scopes, revocation and kind-bound blob access", async (t) => {
  const source = fixture(t, a).store,
    target = fixture(t, b).store;
  const knowledgeItem = source.publish(
    "knowledge",
    knowledge("terrain ".repeat(8192)),
  );
  const skillItem = source.publish("skill", skill());
  const incoming = trust(a, [entry(b, 3447, ["knowledge:exchange"])]);
  const port = await server(t, a, source, incoming),
    outgoing = trust(b, [entry(a, port)])[0];
  await synchronize_distribution({
    store: target,
    identity: b,
    peer: outgoing,
    kind: "knowledge",
  });
  assert.equal(target.status().records, 1);
  await assert.rejects(
    peer_request({
      identity: b,
      peer: outgoing,
      route: `/peer/v1/distribution/skill/blob/${skillItem.digest}`,
    }),
    { code: "SCOPE_DENIED" },
  );
  await assert.rejects(
    peer_request({
      identity: b,
      peer: outgoing,
      route: `/peer/v1/distribution/knowledge/blob/${skillItem.digest}`,
    }),
    { code: "RESNAPSHOT_REQUIRED" },
  );
  incoming[0].revoked = true;
  await assert.rejects(
    peer_request({
      identity: b,
      peer: outgoing,
      route: `/peer/v1/distribution/knowledge/blob/${knowledgeItem.digest}`,
    }),
  );
});

test("peer worker automatically pulls distributed candidates without touching local knowledge/activation", async (t) => {
  const source = fixture(t, a).store;
  source.publish("knowledge", knowledge());
  const port = await server(t, a, source, trust(a, [entry(b, 3447)]));
  const directory = temp(t);
  write_json(path.join(directory, "identity.json"), b);
  write_json(path.join(directory, "trust.json"), {
    contract_version: 1,
    peers: [entry(a, port)],
  });
  const runtime = new PeerRuntime({
    directory,
    settings: { host: "127.0.0.1", port: 0 },
    poll_ms: 20,
    probe_interval_ms: 1000,
  });
  dispose(t, () => runtime.close());
  const deadline = Date.now() + 10000;
  while (
    (runtime.distribution?.store.status().records ?? 0) !== 1 &&
    Date.now() < deadline
  )
    await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(runtime.distribution.store.status().records, 1);
  assert.equal(runtime.distribution.store.status().published, 0);
  assert.equal(runtime.distribution.store.status().adoptions, 0);
});

test("disk/corruption failures preserve cursor and public status exposes no payload", async (t) => {
  const source = fixture(t, a).store,
    target = fixture(t, b).store;
  const item = source.publish("knowledge", knowledge());
  target.free_disk = () => 0;
  await assert.rejects(
    synchronize_distribution({
      store: target,
      identity: b,
      peer: entry(a, 3447),
      kind: "knowledge",
      request: memory(source),
    }),
    /DISK_PRESSURE/,
  );
  assert.equal(target.cursor(a.node_id, "knowledge").cursor, 0);
  source.db
    .prepare("UPDATE records SET body=? WHERE digest=?")
    .run(Buffer.from("{}"), item.digest);
  assert.throws(() => source.get(item.digest), /CORRUPT_DISTRIBUTION/);
  const app = create_app({
    distribution_status: () => ({
      state: "ready",
      records: 1,
      published: 1,
      adoptions: 0,
      quarantined: 0,
      text: "private",
      node: a.node_id,
    }),
  }).listen(0, "127.0.0.1");
  dispose(t, () => new Promise((resolve) => app.close(resolve)));
  await once(app, "listening");
  const response = await fetch(
      `http://127.0.0.1:${app.address().port}/distribution/status`,
    ),
    value = await response.json();
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(Object.keys(value).length, 6);
  assert.equal(JSON.stringify(value).includes("private"), false);
});

test("local CLI requires publication review and never creates or exports an identity implicitly", (t) => {
  const directory = temp(t);
  write_json(path.join(directory, "identity.json"), a);
  const knowledgeDir = path.join(directory, "knowledge"),
    local = new KnowledgeStore(knowledgeDir);
  local.put("terrain", "v1", knowledge().text);
  local.close();
  const options = {
    cwd: import.meta.dirname,
    encoding: "utf8",
    env: {
      ...process.env,
      FRACTO_AI_PEER_DATA_DIR: directory,
      FRACTO_AI_KNOWLEDGE_DIR: knowledgeDir,
    },
  };
  const rejected = spawnSync(
    process.execPath,
    ["distribution/cli.js", "publish-knowledge", "terrain", "v1", "wrong"],
    options,
  );
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /PUBLICATION_REVIEW_REQUIRED/);
  const result = spawnSync(
    process.execPath,
    [
      "distribution/cli.js",
      "publish-knowledge",
      "terrain",
      "v1",
      "--approved-nonpersonal",
    ],
    options,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).record.payload.text, knowledge().text);
  assert.equal(result.stdout.includes("private_key"), false);
});

test("catalog capacity rejects new publication without pruning records or advancing origin sequence", (t) => {
  const { store } = fixture(t, a),
    epoch = store.settings().origin_epoch;
  const insert = store.db.prepare(
    "INSERT INTO records VALUES(?,?,?,?,?,?,?,?)",
  );
  store.transaction(() => {
    for (let sequence = 1; sequence <= 1000; sequence++) {
      const value = {
        contract_version: 1,
        kind: "knowledge",
        origin: { node_id: b.node_id, epoch, sequence },
        payload: knowledge(),
      };
      const bytes = encode(value);
      insert.run(
        bytes_hash(bytes),
        "knowledge",
        b.node_id,
        epoch,
        sequence,
        bytes,
        b.node_id,
        Date.now(),
      );
    }
  });
  assert.throws(
    () => store.publish("knowledge", knowledge("New local terrain")),
    /DISTRIBUTION_CAPACITY/,
  );
  assert.equal(store.status().records, 1000);
  assert.equal(store.status().published, 0);
  assert.equal(store.settings().origin_sequence, 0);
});
