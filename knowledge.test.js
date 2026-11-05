import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { KnowledgeStore, read_document } from "./knowledge/storage.js";
import { create_knowledge_runtime } from "./knowledge/runtime.js";
import { create_app } from "./app.js";

const fixture = (t, options) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fracto-knowledge-"));
  const opened = [];
  const open = (extra = options) => {
    const store = new KnowledgeStore(directory, extra);
    opened.push(store);
    return store;
  };
  t.after(() => {
    for (const store of opened) store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, open, store: open() };
};

test("knowledge survives reopening with stable provenance and literal bounded search", (t) => {
  const { store, open } = fixture(t);
  const record = store.put(
    "terrain-contract",
    "rev-1",
    "Terrain meshes require valid tile dependencies.",
  );
  assert.match(record.digest, /^[a-f0-9]{64}$/);
  store.close();
  const restored = open();
  assert.equal(
    restored.get("terrain-contract").text,
    "Terrain meshes require valid tile dependencies.",
  );
  assert.equal(restored.get("terrain-contract").digest, record.digest);
  assert.equal(restored.search("terrain meshes")[0].revision, "rev-1");
  assert.deepEqual(restored.search('terrain" OR "absent'), []);
  assert.throws(() => restored.search(" "), /INVALID_QUERY/);
  assert.throws(
    () => restored.search("one two three four five six seven eight nine"),
    /INVALID_QUERY/,
  );
});

test("immutable revisions, stale-writer protection, retirement and history", (t) => {
  const { store, open } = fixture(t);
  store.put("terrain", "v1", "obsolete terrain rule");
  assert.equal(
    store.put("terrain", "v1", "obsolete terrain rule").replayed,
    true,
  );
  assert.throws(
    () => store.put("terrain", "v1", "different"),
    /REVISION_CONFLICT/,
  );
  const second = open();
  second.put("terrain", "v2", "replacement mesh rule", "v1");
  assert.throws(
    () => store.put("terrain", "v3", "stale", "v1"),
    /CURRENT_REVISION_CONFLICT/,
  );
  assert.deepEqual(store.search("obsolete"), []);
  assert.equal(store.search("replacement")[0].revision, "v2");
  assert.equal(store.get("terrain", "v1").text, "obsolete terrain rule");
  assert.throws(
    () => store.retire("terrain", "v1"),
    /CURRENT_REVISION_CONFLICT/,
  );
  store.retire("terrain", "v2");
  assert.deepEqual(store.search("replacement"), []);
  assert.equal(store.status().sources, 0);
  store.put("terrain", "v3", "restored terrain", "v2");
  assert.equal(store.search("restored").length, 1);
});

test("invalid inputs and disk pressure never commit a revision", (t) => {
  const { store } = fixture(t, { free_disk: () => 0 });
  assert.throws(() => store.put("../escape", "v1", "text"), /INVALID_LABEL/);
  assert.throws(
    () => store.put("terrain", "v1", "a".repeat(65537)),
    /DOCUMENT_TOO_LARGE/,
  );
  assert.throws(
    () => store.put("terrain", "v1", "bad\0text"),
    /INVALID_DOCUMENT/,
  );
  assert.throws(() => store.put("terrain", "v1", "valid"), /DISK_PRESSURE/);
  assert.equal(store.status().revisions, 0);
});

test("content tampering fails closed; interrupted imports recover without deleting committed or unrelated files", (t) => {
  const { directory, store, open } = fixture(t);
  const record = store.put("terrain", "v1", "terrain knowledge");
  const committed = path.join(directory, "documents", `${record.digest}.txt`);
  const orphan = path.join(directory, "documents", `${"f".repeat(64)}.txt`);
  const unrelated = path.join(directory, "documents", "notes.txt");
  fs.writeFileSync(orphan, "orphan");
  fs.writeFileSync(unrelated, "keep");
  store.close();
  const restored = open();
  assert.equal(fs.existsSync(orphan), false);
  assert.equal(fs.readFileSync(unrelated, "utf8"), "keep");
  assert.equal(restored.get("terrain").text, "terrain knowledge");
  fs.writeFileSync(committed, "tampered");
  assert.throws(() => restored.get("terrain"), /CORRUPT_DOCUMENT/);
  assert.throws(() => restored.search("terrain"), /CORRUPT_DOCUMENT/);
});

test("UTF-8 import and CLI operate against the same store while it is open", (t) => {
  const { directory, store } = fixture(t);
  const input = path.join(directory, "approved.md");
  fs.writeFileSync(input, "Terrain café reference");
  assert.equal(read_document(input), "Terrain café reference");
  const result = spawnSync(
    process.execPath,
    ["knowledge/cli.js", "put", "terrain", "v1", input],
    {
      cwd: import.meta.dirname,
      encoding: "utf8",
      env: { ...process.env, FRACTO_AI_KNOWLEDGE_DIR: directory },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(store.search("café")[0].source, "terrain");
  fs.writeFileSync(input, Buffer.from([0xff]));
  assert.throws(() => read_document(input), /INVALID_DOCUMENT/);
  const bad = spawnSync(
    process.execPath,
    ["knowledge/cli.js", "get", "missing"],
    {
      cwd: import.meta.dirname,
      encoding: "utf8",
      env: { ...process.env, FRACTO_AI_KNOWLEDGE_DIR: directory },
    },
  );
  assert.equal(bad.status, 1);
  assert.equal(bad.stderr.includes(directory), false);
  assert.match(bad.stderr, /KNOWLEDGE_NOT_FOUND/);
});

test("unknown schema is preserved and knowledge failure leaves health ready", async (t) => {
  const { directory, store } = fixture(t);
  store.db.exec("PRAGMA user_version=99");
  store.close();
  const original = console.error;
  console.error = () => {};
  try {
    assert.equal(
      create_knowledge_runtime({ FRACTO_AI_KNOWLEDGE_DIR: directory }),
      null,
    );
  } finally {
    console.error = original;
  }
  const server = create_app({
    knowledge_status: () => {
      throw new Error("private");
    },
  }).listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual(
    await fetch(`${base}/knowledge/status`).then((r) => r.json()),
    { contract_version: 1, state: "unavailable" },
  );
  assert.equal((await fetch(`${base}/readyz`)).status, 200);
  assert.equal((await fetch(`${base}/knowledge/search?q=terrain`)).status, 404);
});

test("public status serializes only allowlisted aggregate fields", async (t) => {
  const server = create_app({
    knowledge_status: () => ({
      state: "ready",
      sources: 1,
      revisions: 2,
      revision_limit: 1000,
      document_byte_limit: 65536,
      search_limit: 10,
      text: "private contents",
      path: "private directory",
      owner: "private identity",
    }),
  }).listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, "listening");
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/knowledge/status`,
  );
  const body = await response.json();
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(body.sources, 1);
  assert.equal(JSON.stringify(body).includes("private"), false);
  assert.equal(Object.keys(body).length, 7);
});

test("failed SQL publication rolls back metadata and index, then orphan cleanup permits retry", (t) => {
  const { store, open, directory } = fixture(t);
  store.db.exec(
    "CREATE TRIGGER reject_import BEFORE INSERT ON revisions BEGIN SELECT RAISE(ABORT,'fixture failure'); END",
  );
  assert.throws(
    () => store.put("terrain", "v1", "orphaned terrain import"),
    /fixture failure/,
  );
  assert.equal(store.status().revisions, 0);
  assert.deepEqual(store.search("terrain"), []);
  assert.equal(fs.readdirSync(path.join(directory, "documents")).length, 1);
  store.db.exec("DROP TRIGGER reject_import");
  store.close();
  const recovered = open();
  assert.equal(fs.readdirSync(path.join(directory, "documents")).length, 0);
  recovered.put("terrain", "v1", "orphaned terrain import");
  assert.equal(recovered.search("terrain").length, 1);
});

test("search and source listing have bounded pages and preserve words at chunk boundaries", (t) => {
  const { store } = fixture(t);
  for (let n = 0; n < 22; n++)
    store.put(
      `source-${String(n).padStart(2, "0")}`,
      "v1",
      "common terrain reference",
    );
  assert.equal(store.search("common").length, 10);
  const page = store.list();
  assert.equal(page.items.length, 20);
  assert.equal(store.list(page.next_cursor).items.length, 2);
  assert.equal(store.list(page.next_cursor).next_cursor, null);
  store.put("chunked", "v1", "x ".repeat(998) + "boundaryword terrain");
  assert.equal(store.search("boundaryword")[0].source, "chunked");
});
