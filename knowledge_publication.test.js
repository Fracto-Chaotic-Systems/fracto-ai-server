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
import { validate_bundle } from "./subject_providers/bundle_contract.js";
import { canonical } from "./subject_providers/validation.js";
import { digest } from "./subject_providers/bundle_sources.js";

const provider_id = "ui-features";
const make_bundle = (
  contents = { alpha: "firstalpha", beta: "firstbeta" },
  nonce = "first",
) => {
  const provider = validate_provider({
    contract_version: 1,
    provider_id,
    subject_id: "application-ui",
    extractor: { id: "ui-catalog", version: "1.0.0" },
    sources: [
      { id: "catalog", repository: "ui", path: "src/features/catalog.json" },
    ],
    documents: Object.keys(contents).map((id) => ({
      id,
      source_ids: ["catalog"],
      format: "markdown",
      validation: {
        profile: "reference-text-v1",
        required_sections: ["Purpose"],
      },
    })),
    limits: {
      source_bytes: 1024,
      total_source_bytes: 1024,
      document_bytes: 65536,
      total_document_bytes: 131072,
    },
  });
  const documents = provider.documents.map(({ id }) => ({
    id,
    text: `# ${id}\n\n## Purpose\n${contents[id]}\n`,
  }));
  const body = {
    contract_version: 1,
    manifest: {
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
      documents: documents.map((document) => ({
        id: document.id,
        source: knowledge_source_id(provider, document.id),
        revision: `v${digest(document.text)}`,
        digest: digest(document.text),
        bytes: Buffer.byteLength(document.text),
        format: "markdown",
        source_ids: ["catalog"],
      })),
    },
    documents,
  };
  return validate_bundle({ ...body, digest: digest(canonical(body)) });
};
const fixture = (t, options = {}) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "fracto-publication-"),
  );
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
    assert.ok(path.basename(directory).startsWith("fracto-publication-"));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, open, store: open() };
};

test("publication pins every document to one immutable generation across writers and reopening", (t) => {
  const { store, open } = fixture(t);
  const first = make_bundle();
  store.reconcile_bundle(first);
  assert.throws(
    () => store.published_bundle(provider_id),
    /BUNDLE_PUBLICATION_NOT_FOUND/,
  );
  const published = store.publish_bundle(provider_id, first.digest);
  assert.equal(published.documents, 2);
  const reader = open({ read_only: true });
  const pinned = reader.published_bundle(provider_id);
  const second = make_bundle(
    { alpha: "secondalpha", beta: "secondbeta" },
    "second",
  );
  const writer = open();
  writer.reconcile_bundle(second);
  // Source search can advance during staging; published readers still get the whole old bundle.
  assert.equal(store.search("secondalpha").length, 1);
  assert.deepEqual(reader.published_bundle(provider_id).bundle, first);
  assert.throws(
    () => writer.publish_bundle(provider_id, second.digest),
    /BUNDLE_PUBLICATION_CONFLICT/,
  );
  writer.publish_bundle(provider_id, second.digest, first.digest);
  assert.deepEqual(reader.published_bundle(provider_id).bundle, second);
  assert.deepEqual(pinned.bundle, first);
  assert.deepEqual(
    reader.read_bundle_snapshot(provider_id, first.digest),
    first,
  );
  pinned.bundle.documents[0].text = "caller mutation";
  assert.deepEqual(
    reader.read_bundle_snapshot(provider_id, first.digest),
    first,
  );
  store.close();
  reader.close();
  writer.close();
  assert.deepEqual(
    open({ read_only: true }).published_bundle(provider_id).bundle,
    second,
  );
});

test("unchanged publication and all pinned reads leave SQLite bytes and timestamps untouched", (t) => {
  let free = 2 * 1024 ** 3;
  const { store, directory, open } = fixture(t, { free_disk: () => free });
  const first = make_bundle();
  store.reconcile_bundle(first);
  const original = store.publish_bundle(provider_id, first.digest);
  const file = path.join(directory, "knowledge/knowledge.sqlite");
  const before = fs.readFileSync(file),
    modified = fs.statSync(file).mtimeMs;
  free = 0;
  const repeated = store.publish_bundle(
    provider_id,
    first.digest,
    first.digest,
  );
  assert.equal(repeated.replayed, true);
  assert.equal(repeated.published_at, original.published_at);
  const reader = open({ read_only: true });
  assert.deepEqual(reader.published_bundle(provider_id).bundle, first);
  assert.deepEqual(
    reader.read_bundle_snapshot(provider_id, first.digest),
    first,
  );
  assert.throws(
    () => reader.publish_bundle(provider_id, first.digest, first.digest),
    /KNOWLEDGE_READ_ONLY/,
  );
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.statSync(file).mtimeMs, modified);
});

test("removed documents leave the new publication completely and remain only in historical snapshots", (t) => {
  const { store } = fixture(t);
  const first = make_bundle();
  store.reconcile_bundle(first);
  store.publish_bundle(provider_id, first.digest);
  const second = make_bundle({ alpha: "secondalpha" }, "removed-beta");
  store.reconcile_bundle(second);
  assert.equal(store.published_bundle(provider_id).bundle.documents.length, 2);
  store.publish_bundle(provider_id, second.digest, first.digest);
  assert.deepEqual(
    store.published_bundle(provider_id).bundle.documents.map(({ id }) => id),
    ["alpha"],
  );
  assert.equal(
    store.read_bundle_snapshot(provider_id, first.digest).documents.length,
    2,
  );
  assert.throws(
    () => store.publish_bundle(provider_id, first.digest, second.digest),
    /STALE_KNOWLEDGE_BUNDLE/,
  );
});

test("local source collisions cannot produce a partial publication or replace local bytes", (t) => {
  const { store } = fixture(t);
  const first = make_bundle();
  const source = first.manifest.documents[0].source;
  store.put(source, "local", "local reference");
  assert.equal(store.reconcile_bundle(first).skipped, 1);
  assert.deepEqual(
    store.read_bundle_snapshot(provider_id, first.digest),
    first,
  );
  assert.throws(
    () => store.publish_bundle(provider_id, first.digest),
    /BUNDLE_PUBLICATION_INCOMPLETE/,
  );
  assert.throws(
    () => store.published_bundle(provider_id),
    /BUNDLE_PUBLICATION_NOT_FOUND/,
  );
  assert.equal(store.get(source).text, "local reference");
});

test("operator edits and explicit retirements disable future publication reads without rewriting pinned history", (t) => {
  const { store, open } = fixture(t);
  const first = make_bundle();
  store.reconcile_bundle(first);
  store.publish_bundle(provider_id, first.digest);
  const pinned = store.published_bundle(provider_id);
  const other = open();
  const metadata = first.manifest.documents[0];
  // A failed operator write must not disable a valid publication.
  assert.throws(
    () => other.put(metadata.source, "local", "changed", "stale"),
    /CURRENT_REVISION_CONFLICT/,
  );
  assert.equal(store.published_bundle(provider_id).bundle.digest, first.digest);
  other.retire(metadata.source, metadata.revision);
  assert.throws(
    () => store.published_bundle(provider_id),
    /BUNDLE_PUBLICATION_DISABLED/,
  );
  assert.deepEqual(pinned.bundle, first);
  assert.deepEqual(
    store.read_bundle_snapshot(provider_id, first.digest),
    first,
  );
  assert.equal(store.bundle_status(provider_id).publication.disabled, 1);
  const next = make_bundle({ alpha: "secondalpha", beta: "secondbeta" }, "new");
  assert.equal(store.reconcile_bundle(next).skipped, 1);
  assert.throws(
    () => store.publish_bundle(provider_id, next.digest, first.digest),
    /BUNDLE_PUBLICATION_INCOMPLETE/,
  );
  // Identical-content manual writes also explicitly take ownership.
  const beta = first.manifest.documents[1];
  const current = other.get(beta.source);
  other.put(current.source, current.revision, current.text);
  assert.throws(
    () => store.publish_bundle(provider_id, next.digest, first.digest),
    /BUNDLE_PUBLICATION_INCOMPLETE/,
  );
});

test("publication failure preserves the old pointer; late snapshot persistence failure rolls back staging", (t) => {
  let free = 2 * 1024 ** 3;
  const { store } = fixture(t, { free_disk: () => free });
  const first = make_bundle();
  store.reconcile_bundle(first);
  store.publish_bundle(provider_id, first.digest);
  const second = make_bundle(
    { alpha: "secondalpha", beta: "secondbeta" },
    "second",
  );
  store.db.exec(
    "CREATE TRIGGER reject_artifact BEFORE INSERT ON bundle_artifacts BEGIN SELECT RAISE(ABORT,'artifact-failure'); END",
  );
  assert.throws(() => store.reconcile_bundle(second), /artifact-failure/);
  assert.equal(store.bundle_status(provider_id).digest, first.digest);
  assert.equal(store.status().revisions, 2);
  assert.deepEqual(store.published_bundle(provider_id).bundle, first);
  store.db.exec("DROP TRIGGER reject_artifact");
  store.reconcile_bundle(second);
  free = 0;
  assert.throws(
    () => store.publish_bundle(provider_id, second.digest, first.digest),
    /DISK_PRESSURE/,
  );
  assert.deepEqual(store.published_bundle(provider_id).bundle, first);
  free = 2 * 1024 ** 3;
  store.db.exec(
    "CREATE TRIGGER reject_publication BEFORE UPDATE ON bundle_publications BEGIN SELECT RAISE(ABORT,'publication-failure'); END",
  );
  assert.throws(
    () => store.publish_bundle(provider_id, second.digest, first.digest),
    /publication-failure/,
  );
  assert.deepEqual(store.published_bundle(provider_id).bundle, first);
});

test("snapshot corruption or missing content fails closed without repairing or moving publication", (t) => {
  const { store } = fixture(t);
  const first = make_bundle();
  store.reconcile_bundle(first);
  store.publish_bundle(provider_id, first.digest);
  const altered = structuredClone(first);
  altered.documents.pop();
  store.db
    .prepare("UPDATE bundle_artifacts SET body=?")
    .run(JSON.stringify(altered));
  assert.throws(
    () => store.published_bundle(provider_id),
    /CORRUPT_BUNDLE_SNAPSHOT/,
  );
  assert.throws(() => store.reconcile_bundle(first), /CORRUPT_BUNDLE_SNAPSHOT/);
  assert.throws(
    () => store.publish_bundle(provider_id, first.digest, first.digest),
    /CORRUPT_BUNDLE_SNAPSHOT/,
  );
  assert.equal(
    store.bundle_status(provider_id).publication.digest,
    first.digest,
  );
  store.db.exec("DELETE FROM bundle_artifacts");
  assert.throws(
    () => store.published_bundle(provider_id),
    /CORRUPT_BUNDLE_SNAPSHOT/,
  );
  assert.throws(
    () => store.read_bundle_snapshot(provider_id, first.digest),
    /BUNDLE_SNAPSHOT_NOT_FOUND/,
  );
});

test("schema-two migration does not infer complete historical content or auto-publish a staging head", (t) => {
  const { store, open } = fixture(t);
  const first = make_bundle();
  store.reconcile_bundle(first);
  store.db.exec(
    "DROP TABLE bundle_artifacts; DROP TABLE bundle_publications; DROP TABLE bundle_refresh; PRAGMA user_version=2",
  );
  store.close();
  const reader = open({ read_only: true });
  assert.equal(reader.bundle_status(provider_id).publication, null);
  assert.throws(
    () => reader.published_bundle(provider_id),
    /BUNDLE_PUBLICATION_NOT_FOUND/,
  );
  reader.close();
  const migrated = open();
  assert.throws(
    () => migrated.publish_bundle(provider_id, first.digest),
    /BUNDLE_SNAPSHOT_NOT_FOUND/,
  );
  assert.equal(migrated.reconcile_bundle(first).unchanged, 2);
  assert.equal(migrated.publish_bundle(provider_id, first.digest).documents, 2);
});

test(
  "CLI publishes and reads the generated seven-document snapshot without building or model access",
  {
    skip: !fs.existsSync(
      new URL("./generated/knowledge/ui-features.bundle.json", import.meta.url),
    ),
  },
  (t) => {
    const { directory } = fixture(t);
    const env = {
      ...process.env,
      FRACTO_AI_KNOWLEDGE_DIR: path.join(directory, "cli-knowledge"),
    };
    const run = (...args) => {
      const result = spawnSync(
        process.execPath,
        [path.join(import.meta.dirname, "knowledge/cli.js"), ...args],
        { env, encoding: "utf8", windowsHide: true },
      );
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    const staged = run("reconcile");
    assert.equal(run("bundle-publish", staged.digest, "none").documents, 7);
    assert.equal(run("bundle-read").documents.length, 7);
    assert.equal(run("bundle-read", staged.digest).digest, staged.digest);
    assert.equal(run("bundle-publication").documents.length, 7);
  },
);
