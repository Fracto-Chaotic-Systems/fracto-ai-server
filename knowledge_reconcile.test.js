import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { KnowledgeStore } from "./knowledge/storage.js";
import {
  validate_provider,
  provider_digest,
  knowledge_source_id,
} from "./subject_providers/contracts.js";
import { canonical } from "./subject_providers/validation.js";
import { digest } from "./subject_providers/bundle_sources.js";
import {
  validate_bundle,
  bundle_bytes,
} from "./subject_providers/bundle_contract.js";
import { read_ui_bundle } from "./subject_providers/reconcile.js";

const definition = JSON.parse(
  fs.readFileSync(
    new URL("./subject_providers/ui.json", import.meta.url),
    "utf8",
  ),
);
const text = (name) =>
  `# ${name}\n\n## Purpose\n${name} reference.\n\n## Features\nNavigation.\n\n## Permissions\nAdministrator.\n\n## Configuration\nNames only.\n\n## Limitations\nEvidence only.\n`;
const bundle = (
  contents = { admin: "alphareference", home: "betareference" },
  nonce = "initial",
) => {
  const provider = validate_provider({
    ...definition,
    documents: definition.documents.filter(({ id }) =>
      Object.hasOwn(contents, id),
    ),
  });
  const documents = provider.documents.map(({ id }) => ({
    id,
    text: text(contents[id]),
  }));
  const manifest = {
    provider,
    provider_digest: provider_digest(provider),
    generator: {
      id: "subject-bundle",
      version: "1.0.0",
      fingerprint: "a".repeat(64),
    },
    extractor: { ...provider.extractor, fingerprint: "b".repeat(64) },
    sources: provider.sources.map((source) => ({
      ...source,
      digest: digest(nonce),
      bytes: Buffer.byteLength(nonce),
      repository_revision: null,
      source_state: "unknown",
    })),
    documents: documents.map((document, index) => ({
      id: document.id,
      source: knowledge_source_id(provider, document.id),
      revision: `v${digest(document.text)}`,
      digest: digest(document.text),
      bytes: Buffer.byteLength(document.text),
      format: "markdown",
      source_ids: provider.documents[index].source_ids,
    })),
  };
  const result = { contract_version: 1, manifest, documents };
  return validate_bundle({ ...result, digest: digest(canonical(result)) });
};
const source = (name) =>
  knowledge_source_id(validate_provider(definition), name);
const fixture = (t, options = {}) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fracto-reconcile-"));
  const stores = [];
  const open = (extra = options) => {
    const store = new KnowledgeStore(path.join(directory, "knowledge"), extra);
    stores.push(store);
    return store;
  };
  t.after(() => {
    for (const store of stores) store.close();
    assert.equal(
      path.dirname(path.resolve(directory)),
      path.resolve(os.tmpdir()),
    );
    assert.ok(path.basename(directory).startsWith("fracto-reconcile-"));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, open, store: open() };
};

test("bundle reconciliation persists provenance and searchable revisions; replay performs no database writes", (t) => {
  const { store, open, directory } = fixture(t);
  const input = bundle();
  const result = store.reconcile_bundle(input);
  assert.equal(result.inserted, 2);
  assert.equal(store.search("alphareference")[0].source, source("admin"));
  assert.deepEqual(store.bundle_status("ui-features").manifest, input.manifest);
  const file = path.join(directory, "knowledge/knowledge.sqlite");
  const before = fs.readFileSync(file);
  const replay = store.reconcile_bundle(input);
  assert.equal(replay.replayed, true);
  assert.equal(replay.unchanged, 2);
  assert.deepEqual(fs.readFileSync(file), before);
  store.close();
  const reopened = open();
  assert.equal(reopened.bundle_status("ui-features").digest, input.digest);
  assert.equal(reopened.get(source("admin")).text, text("alphareference"));
  assert.equal(reopened.bundle_status("ui-features").snapshots, 1);
});

test("content and provenance changes have independent histories; known stale snapshots cannot roll back", (t) => {
  const { store } = fixture(t);
  const first = bundle();
  store.reconcile_bundle(first);
  const second = bundle({ admin: "gammareference", home: "betareference" });
  const update = store.reconcile_bundle(second);
  assert.equal(update.updated, 1);
  assert.equal(update.unchanged, 1);
  assert.equal(store.status().revisions, 3);
  assert.equal(
    store.get(source("admin"), first.manifest.documents[0].revision).text,
    text("alphareference"),
  );
  assert.equal(store.search("alphareference").length, 0);
  assert.throws(() => store.reconcile_bundle(first), /STALE_KNOWLEDGE_BUNDLE/);
  const metadata = bundle(
    { admin: "gammareference", home: "betareference" },
    "metadata-change",
  );
  assert.equal(store.reconcile_bundle(metadata).unchanged, 2);
  assert.equal(store.status().revisions, 3);
  // A newly reviewed source snapshot can legitimately return to historical content.
  const reverted = bundle(undefined, "new-source-with-prior-content");
  assert.equal(store.reconcile_bundle(reverted).updated, 1);
  assert.equal(store.status().revisions, 3);
  assert.equal(store.search("alphareference").length, 1);
});

test("local edits, digest-shaped local revisions and explicit retirement survive new bundles and reopening", (t) => {
  const { store, open } = fixture(t);
  store.reconcile_bundle(bundle());
  const second = open();
  const local = text("localoverride");
  second.put(
    source("admin"),
    `v${digest(local)}`,
    local,
    second.current(source("admin")).current_revision,
  );
  second.retire(
    source("home"),
    second.current(source("home")).current_revision,
  );
  const next = bundle({ admin: "newadmin", home: "newhome" });
  assert.equal(store.reconcile_bundle(next).skipped, 2);
  assert.equal(store.get(source("admin")).text, local);
  assert.equal(store.current(source("home")).retired, 1);
  second.close();
  store.close();
  assert.equal(
    open().reconcile_bundle(bundle(undefined, "another-source")).skipped,
    2,
  );
});

test("preexisting source collisions are never adopted; explicit same-content puts claim a local override", (t) => {
  const { store } = fixture(t);
  const first = bundle();
  const metadata = first.manifest.documents[0];
  store.put(metadata.source, metadata.revision, first.documents[0].text);
  assert.equal(store.reconcile_bundle(first).skipped, 1);
  assert.equal(
    store.db
      .prepare("SELECT count(*) AS n FROM bundle_documents WHERE source=?")
      .get(source("admin")).n,
    0,
  );
  const home = store.get(source("home"));
  store.put(home.source, home.revision, home.text);
  assert.equal(
    store.reconcile_bundle(bundle({ admin: "newadmin", home: "newhome" }))
      .skipped,
    2,
  );
});

test("complete declaration removals retire owned sources; new snapshots can restore provider retirements", (t) => {
  const { store } = fixture(t);
  const first = bundle();
  store.reconcile_bundle(first);
  const removed = bundle({ home: "betareference" });
  assert.equal(store.reconcile_bundle(removed).retired, 1);
  assert.equal(store.search("alphareference").length, 0);
  assert.equal(store.get(source("admin")).text, text("alphareference"));
  assert.equal(
    store.reconcile_bundle(bundle(undefined, "restored-source")).updated,
    1,
  );
  assert.equal(store.search("alphareference").length, 1);
  store.reconcile_bundle(bundle({ home: "betareference" }, "removed-again"));
  store.retire(
    source("admin"),
    store.current(source("admin")).current_revision,
  );
  assert.equal(
    store.reconcile_bundle(bundle(undefined, "operator-retirement-wins"))
      .skipped,
    1,
  );
  assert.equal(store.current(source("admin")).retired, 1);
});

test("invalid and partial bundles, disk failure and mid-import errors cannot partially commit", (t) => {
  let available = 2 * 1024 ** 3;
  const { store, open, directory } = fixture(t, { free_disk: () => available });
  const input = bundle();
  const invalid = structuredClone(input);
  invalid.documents.pop();
  assert.throws(
    () => store.reconcile_bundle(invalid),
    /INVALID_KNOWLEDGE_BUNDLE/,
  );
  available = 0;
  assert.throws(() => store.reconcile_bundle(input), /DISK_PRESSURE/);
  assert.equal(store.status().revisions, 0);
  available = 2 * 1024 ** 3;
  store.db.exec(
    `CREATE TRIGGER fail_home BEFORE INSERT ON revisions WHEN NEW.source='${source("home")}' BEGIN SELECT RAISE(ABORT,'fixture-failure'); END`,
  );
  assert.throws(() => store.reconcile_bundle(input), /fixture-failure/);
  assert.equal(store.status().revisions, 0);
  assert.equal(store.current(source("admin")), null);
  assert.equal(store.bundle_status("ui-features"), null);
  assert.equal(
    store.db.prepare("SELECT count(*) AS n FROM bundle_documents").get().n,
    0,
  );
  store.db.exec("DROP TRIGGER fail_home");
  store.close();
  const reopened = open();
  assert.deepEqual(
    fs.readdirSync(path.join(directory, "knowledge/documents")),
    [],
  );
  assert.equal(reopened.reconcile_bundle(input).inserted, 2);
  const reader = open({ read_only: true });
  assert.throws(() => reader.reconcile_bundle(input), /KNOWLEDGE_READ_ONLY/);
});

test("schema-one migration preserves existing knowledge and read-only access", (t) => {
  const { store, open } = fixture(t);
  store.put("existing", "v1", "existing reference");
  store.db.exec(
    "DROP TABLE bundle_snapshots; DROP TABLE bundle_heads; DROP TABLE bundle_documents; DROP TABLE bundle_artifacts; DROP TABLE bundle_publications; DROP TABLE bundle_refresh; PRAGMA user_version=1",
  );
  store.close();
  const reader = open({ read_only: true });
  assert.equal(reader.get("existing").text, "existing reference");
  assert.equal(reader.bundle_status("ui-features"), null);
  reader.close();
  const migrated = open();
  assert.equal(
    migrated.db.prepare("PRAGMA user_version").get().user_version,
    4,
  );
  assert.equal(migrated.get("existing").text, "existing reference");
  assert.equal(migrated.reconcile_bundle(bundle()).inserted, 2);
});

test("artifact admission is bounded, fixed-provider and independent of checkouts or models", (t) => {
  const { directory, store } = fixture(t);
  const root = path.join(directory, "artifact");
  fs.mkdirSync(path.join(root, "subject_providers"), { recursive: true });
  fs.mkdirSync(path.join(root, "generated/knowledge"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "subject_providers/ui.json"),
    JSON.stringify(definition),
  );
  const file = path.join(root, "generated/knowledge/ui-features.bundle.json");
  assert.throws(() => read_ui_bundle(root), /BUNDLE_ADMISSION_FAILED/);
  fs.writeFileSync(file, bundle_bytes(bundle()));
  assert.throws(() => read_ui_bundle(root), /BUNDLE_PROVIDER_MISMATCH/);
  const all = Object.fromEntries(
    definition.documents.map(({ id }) => [id, id]),
  );
  const complete = bundle(all);
  fs.writeFileSync(file, bundle_bytes(complete));
  assert.equal(store.reconcile_bundle(read_ui_bundle(root)).inserted, 7);
  fs.writeFileSync(file, Buffer.from([0xff]));
  assert.throws(() => read_ui_bundle(root), /BUNDLE_ADMISSION_FAILED/);
  fs.writeFileSync(file, "x".repeat(4 * 1024 * 1024 + 1));
  assert.throws(() => read_ui_bundle(root), /BUNDLE_ADMISSION_FAILED/);
});

test("snapshot capacity fails atomically and replay remains allowed under disk pressure", (t) => {
  let free = 2 * 1024 ** 3;
  const { store } = fixture(t, { free_disk: () => free });
  const first = bundle();
  store.reconcile_bundle(first);
  free = 0;
  assert.equal(store.reconcile_bundle(first).unchanged, 2);
  free = 2 * 1024 ** 3;
  store.transaction(() => {
    for (let index = 0; index < 999; index++)
      store.db
        .prepare("INSERT INTO bundle_snapshots VALUES(?,?,?,?,?)")
        .run("fixture", digest(String(index)), "{}", 0, "{}");
  });
  assert.throws(
    () => store.reconcile_bundle(bundle(undefined, "new-source")),
    /BUNDLE_CAPACITY/,
  );
  assert.equal(store.bundle_status("ui-features").digest, first.digest);
});

const generated = new URL(
  "./generated/knowledge/ui-features.bundle.json",
  import.meta.url,
);
test(
  "local CLI reconciles the actual generated bundle into a persistent isolated store",
  { skip: !fs.existsSync(generated) },
  (t) => {
    const { directory } = fixture(t);
    const env = {
      ...process.env,
      FRACTO_AI_KNOWLEDGE_DIR: path.join(directory, "cli-knowledge"),
    };
    const run = (command) => {
      const result = spawnSync(
        process.execPath,
        [path.join(import.meta.dirname, "knowledge/cli.js"), command],
        { env, encoding: "utf8", windowsHide: true },
      );
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    assert.equal(run("reconcile").inserted, 7);
    assert.equal(run("reconcile").unchanged, 7);
    assert.equal(run("bundle-status").manifest.documents.length, 7);
    assert.equal(fs.existsSync(path.join(directory, "skills")), false);
  },
);
