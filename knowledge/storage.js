import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { secure_directory, write_bytes } from "../peers/files.js";
import {
  validate_bundle,
  bundle_bytes,
  MAX_BUNDLE_BYTES,
} from "../subject_providers/bundle_contract.js";
import { canonical } from "../subject_providers/validation.js";

export class KnowledgeError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
const fail = (code) => {
  throw new KnowledgeError(code);
};
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const label = (value) => {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(value))
    fail("INVALID_LABEL");
};
const bundle_digest = (value) => {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    fail("INVALID_BUNDLE_DIGEST");
};
const regular = (filename) => {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) fail("INVALID_FILE");
  return stat;
};
export const read_document = (filename) => {
  if (regular(filename).size > 65536) fail("DOCUMENT_TOO_LARGE");
  const bytes = fs.readFileSync(filename);
  if (!bytes.length || bytes.length > 65536) fail("INVALID_DOCUMENT");
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("INVALID_DOCUMENT");
  }
  if (!text.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text))
    fail("INVALID_DOCUMENT");
  return text;
};

export class KnowledgeStore {
  constructor(
    directory,
    {
      read_only = false,
      free_disk = () => {
        const stat = fs.statfsSync(directory);
        return Number(stat.bavail) * Number(stat.bsize);
      },
    } = {},
  ) {
    this.directory = path.resolve(directory);
    this.read_only = read_only;
    this.free_disk = free_disk;
    try {
      if (read_only) {
        this.documents = path.join(this.directory, "documents");
        for (const directory of [this.directory, this.documents]) {
          const stat = fs.lstatSync(directory);
          if (!stat.isDirectory() || stat.isSymbolicLink())
            fail("INVALID_FILE");
        }
        const file = path.join(this.directory, "knowledge.sqlite");
        regular(file);
        for (const suffix of ["-journal", "-wal", "-shm"]) {
          if (fs.existsSync(file + suffix)) regular(file + suffix);
        }
        this.db = new DatabaseSync(file, { readOnly: true });
        this.db.exec("PRAGMA busy_timeout=2000; PRAGMA query_only=ON");
        if (
          ![1, 2, 3, 4].includes(
            this.db.prepare("PRAGMA user_version").get().user_version,
          )
        )
          fail("UNKNOWN_SCHEMA");
        return;
      }
      secure_directory(this.directory);
      this.documents = path.join(this.directory, "documents");
      secure_directory(this.documents);
      const file = path.join(this.directory, "knowledge.sqlite");
      for (const suffix of ["", "-journal", "-wal", "-shm"]) {
        if (fs.existsSync(file + suffix)) regular(file + suffix);
      }
      this.db = new DatabaseSync(file);
      if (process.platform !== "win32") fs.chmodSync(file, 0o600);
      this.db.exec(
        "PRAGMA busy_timeout=2000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA max_page_count=16384;",
      );
      this.transaction(() => {
        const version = this.db
          .prepare("PRAGMA user_version")
          .get().user_version;
        if (![0, 1, 2, 3, 4].includes(version)) fail("UNKNOWN_SCHEMA");
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS sources(source TEXT PRIMARY KEY, current_revision TEXT NOT NULL, retired INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE IF NOT EXISTS revisions(source TEXT NOT NULL, revision TEXT NOT NULL, digest TEXT NOT NULL, bytes INTEGER NOT NULL, ingested_at INTEGER NOT NULL, PRIMARY KEY(source, revision));
          CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(source UNINDEXED, revision UNINDEXED, chunk UNINDEXED, body);
          CREATE TABLE IF NOT EXISTS bundle_snapshots(provider TEXT NOT NULL, digest TEXT NOT NULL, manifest TEXT NOT NULL, reconciled_at INTEGER NOT NULL, summary TEXT NOT NULL, PRIMARY KEY(provider,digest));
          CREATE TABLE IF NOT EXISTS bundle_heads(provider TEXT PRIMARY KEY, digest TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS bundle_documents(source TEXT PRIMARY KEY, provider TEXT NOT NULL, document TEXT NOT NULL, revision TEXT NOT NULL, overridden INTEGER NOT NULL DEFAULT 0, managed_retired INTEGER NOT NULL DEFAULT 0, UNIQUE(provider,document));
          CREATE TABLE IF NOT EXISTS bundle_artifacts(provider TEXT NOT NULL, digest TEXT NOT NULL, body TEXT NOT NULL CHECK(length(CAST(body AS BLOB))<=4194304), PRIMARY KEY(provider,digest));
          CREATE TABLE IF NOT EXISTS bundle_publications(provider TEXT PRIMARY KEY, digest TEXT NOT NULL, published_at INTEGER NOT NULL, disabled INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE IF NOT EXISTS bundle_refresh(provider TEXT PRIMARY KEY, digest TEXT NOT NULL);
          PRAGMA user_version=4;
        `);
        const retained = new Set(
          this.db
            .prepare("SELECT digest FROM revisions")
            .all()
            .map((row) => row.digest),
        );
        for (const entry of fs.readdirSync(this.documents, {
          withFileTypes: true,
        })) {
          if (
            /^[a-f0-9]{64}\.txt$/.test(entry.name) &&
            !retained.has(entry.name.slice(0, 64))
          ) {
            const target = path.join(this.documents, entry.name);
            regular(target);
            fs.unlinkSync(target);
          }
        }
      });
    } catch (error) {
      this.close();
      throw error;
    }
  }
  transaction(operation) {
    if (this.read_only) fail("KNOWLEDGE_READ_ONLY");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }
  put(source, revision, text, expected = null) {
    return this.transaction(() => {
      const result = this.#put_revision(source, revision, text, expected);
      this.db
        .prepare("UPDATE bundle_documents SET overridden=1 WHERE source=?")
        .run(source);
      this.#disable_publication(source);
      return result;
    });
  }
  /** Internal transaction helper; public writes also persist an operator override. */
  #put_revision(source, revision, text, expected = null, managed = false) {
    label(source);
    label(revision);
    if (expected !== null) label(expected);
    if (
      typeof text !== "string" ||
      !text.trim() ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)
    )
      fail("INVALID_DOCUMENT");
    const bytes = Buffer.from(text, "utf8");
    if (bytes.length > 65536) fail("DOCUMENT_TOO_LARGE");
    if (bytes.toString("utf8") !== text) fail("INVALID_DOCUMENT");
    const hash = digest(bytes);
    const current = this.db
      .prepare("SELECT * FROM sources WHERE source=?")
      .get(source);
    const previous = this.db
      .prepare("SELECT * FROM revisions WHERE source=? AND revision=?")
      .get(source, revision);
    if (previous) {
      if (previous.digest !== hash) fail("REVISION_CONFLICT");
      if (managed && (current?.current_revision ?? null) !== expected)
        fail("CURRENT_REVISION_CONFLICT");
      if (
        !managed &&
        (current.current_revision !== revision || current.retired)
      )
        fail("CURRENT_REVISION_CONFLICT");
      this.get(source, revision);
      if (managed)
        this.db
          .prepare(
            "UPDATE sources SET current_revision=?,retired=0 WHERE source=?",
          )
          .run(revision, source);
      return { ...previous, replayed: true };
    }
    if ((current?.current_revision ?? null) !== expected)
      fail("CURRENT_REVISION_CONFLICT");
    if (this.db.prepare("SELECT count(*) AS n FROM revisions").get().n >= 1000)
      fail("KNOWLEDGE_CAPACITY");
    if (this.free_disk() < 1024 ** 3) fail("DISK_PRESSURE");
    const filename = path.join(this.documents, `${hash}.txt`);
    if (fs.existsSync(filename)) {
      if (regular(filename).size > 65536) fail("CORRUPT_DOCUMENT");
      if (digest(fs.readFileSync(filename)) !== hash) fail("CORRUPT_DOCUMENT");
    } else write_bytes(filename, bytes, { initial: true });
    const ingested_at = Date.now();
    this.db
      .prepare("INSERT INTO revisions VALUES(?,?,?,?,?)")
      .run(source, revision, hash, bytes.length, ingested_at);
    for (
      let offset = 0, chunk = 0;
      offset < text.length;
      offset += 1800, chunk++
    ) {
      this.db
        .prepare("INSERT INTO chunks VALUES(?,?,?,?)")
        .run(source, revision, chunk, text.slice(offset, offset + 2000));
    }
    this.db
      .prepare(
        "INSERT INTO sources VALUES(?,?,0) ON CONFLICT(source) DO UPDATE SET current_revision=excluded.current_revision,retired=0",
      )
      .run(source, revision);
    return {
      source,
      revision,
      digest: hash,
      bytes: bytes.length,
      ingested_at,
      replayed: false,
    };
  }
  get(source, revision = null) {
    label(source);
    if (revision !== null) label(revision);
    const record =
      revision === null
        ? this.db
            .prepare(
              "SELECT r.* FROM revisions r JOIN sources s ON r.source=s.source AND r.revision=s.current_revision WHERE r.source=?",
            )
            .get(source)
        : this.db
            .prepare("SELECT * FROM revisions WHERE source=? AND revision=?")
            .get(source, revision);
    if (!record) fail("KNOWLEDGE_NOT_FOUND");
    const filename = path.join(this.documents, `${record.digest}.txt`);
    if (regular(filename).size > 65536) fail("CORRUPT_DOCUMENT");
    const bytes = fs.readFileSync(filename);
    if (bytes.length !== record.bytes || digest(bytes) !== record.digest)
      fail("CORRUPT_DOCUMENT");
    return { ...record, text: bytes.toString("utf8"), evidence_only: true };
  }
  search(query) {
    if (typeof query !== "string" || query.length > 256) fail("INVALID_QUERY");
    const words = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (!words.length || words.length > 8) fail("INVALID_QUERY");
    const match = words.map((word) => `"${word}"`).join(" AND ");
    return this.db
      .prepare(
        `SELECT chunks.source, chunks.revision, chunks.chunk, r.digest,
      substr(snippet(chunks,3,'','',' … ',48),1,500) AS excerpt, bm25(chunks) AS rank
      FROM chunks JOIN sources s ON chunks.source=s.source AND chunks.revision=s.current_revision
      JOIN revisions r ON chunks.source=r.source AND chunks.revision=r.revision
      WHERE chunks MATCH ? AND s.retired=0 ORDER BY rank, chunks.source, chunks.chunk LIMIT 10`,
      )
      .all(match)
      .map((row) => {
        this.get(row.source, row.revision);
        return { ...row, evidence_only: true };
      });
  }
  retire(source, expected) {
    label(source);
    label(expected);
    return this.transaction(() => {
      const result = this.db
        .prepare(
          "UPDATE sources SET retired=1 WHERE source=? AND current_revision=?",
        )
        .run(source, expected);
      if (!result.changes) fail("CURRENT_REVISION_CONFLICT");
      this.db
        .prepare("UPDATE bundle_documents SET overridden=1 WHERE source=?")
        .run(source);
      this.#disable_publication(source);
      return { retired: true };
    });
  }
  list(after = "") {
    if (after !== "") label(after);
    const rows = this.db
      .prepare(
        `SELECT r.*, s.retired FROM sources s JOIN revisions r
      ON s.source=r.source AND s.current_revision=r.revision
      WHERE s.source>? ORDER BY s.source LIMIT 21`,
      )
      .all(after);
    const items = rows.slice(0, 20);
    return {
      items,
      next_cursor: rows.length > 20 ? items.at(-1).source : null,
    };
  }
  current(source) {
    label(source);
    return (
      this.db.prepare("SELECT * FROM sources WHERE source=?").get(source) ??
      null
    );
  }
  /** Reconcile a complete reviewed artifact; all database selections change atomically. */
  reconcile_bundle(input) {
    // Detach caller-owned objects before entering the write transaction.
    const bundle = validate_bundle(
      JSON.parse(JSON.stringify(validate_bundle(input))),
    );
    return this.transaction(() => this.#reconcile_bundle(bundle));
  }
  #reconcile_bundle(bundle) {
    const provider = bundle.manifest.provider.provider_id;
    const head = this.db
      .prepare("SELECT digest FROM bundle_heads WHERE provider=?")
      .get(provider);
    const previous = this.db
      .prepare(
        "SELECT digest FROM bundle_snapshots WHERE provider=? AND digest=?",
      )
      .get(provider, bundle.digest);
    const artifact = this.db
      .prepare(
        "SELECT 1 AS present FROM bundle_artifacts WHERE provider=? AND digest=?",
      )
      .get(provider, bundle.digest);
    if (previous && head?.digest !== bundle.digest)
      fail("STALE_KNOWLEDGE_BUNDLE");
    if (!previous || !artifact) {
      if (this.free_disk() < 1024 ** 3) fail("DISK_PRESSURE");
    }
    if (!previous) {
      if (
        this.db.prepare("SELECT count(*) AS n FROM bundle_snapshots").get().n >=
        1000
      )
        fail("BUNDLE_CAPACITY");
      if (
        !head &&
        this.db.prepare("SELECT count(*) AS n FROM bundle_heads").get().n >= 64
      )
        fail("BUNDLE_CAPACITY");
    }
    const result = {
      provider,
      digest: bundle.digest,
      replayed: Boolean(previous),
      inserted: 0,
      updated: 0,
      unchanged: 0,
      retired: 0,
      skipped: 0,
    };
    const present = new Set();
    for (let index = 0; index < bundle.documents.length; index++) {
      const metadata = bundle.manifest.documents[index];
      const { source, revision } = metadata;
      present.add(source);
      const owned = this.db
        .prepare("SELECT * FROM bundle_documents WHERE source=?")
        .get(source);
      const current = this.current(source);
      if (
        (owned &&
          (owned.provider !== provider ||
            owned.overridden ||
            !current ||
            current.current_revision !== owned.revision ||
            Boolean(current.retired) !== Boolean(owned.managed_retired))) ||
        (!owned && current)
      ) {
        result.skipped++;
        continue;
      }
      if (
        current &&
        !current.retired &&
        current.current_revision === revision
      ) {
        this.get(source, revision);
        result.unchanged++;
        continue;
      }
      this.#put_revision(
        source,
        revision,
        bundle.documents[index].text,
        current?.current_revision ?? null,
        true,
      );
      this.db
        .prepare(
          "INSERT INTO bundle_documents(source,provider,document,revision) VALUES(?,?,?,?) ON CONFLICT(source) DO UPDATE SET revision=excluded.revision,managed_retired=0",
        )
        .run(source, provider, metadata.id, revision);
      result[current ? "updated" : "inserted"]++;
    }
    for (const owned of this.db
      .prepare(
        "SELECT * FROM bundle_documents WHERE provider=? ORDER BY source",
      )
      .all(provider)) {
      if (present.has(owned.source)) continue;
      const current = this.current(owned.source);
      if (
        owned.overridden ||
        !current ||
        current.current_revision !== owned.revision ||
        Boolean(current.retired) !== Boolean(owned.managed_retired)
      ) {
        result.skipped++;
        continue;
      }
      if (!current.retired) {
        this.get(owned.source, owned.revision);
        this.db
          .prepare("UPDATE sources SET retired=1 WHERE source=?")
          .run(owned.source);
        this.db
          .prepare(
            "UPDATE bundle_documents SET managed_retired=1 WHERE source=?",
          )
          .run(owned.source);
        result.retired++;
      }
    }
    if (!previous) {
      this.db
        .prepare("INSERT INTO bundle_snapshots VALUES(?,?,?,?,?)")
        .run(
          provider,
          bundle.digest,
          canonical(bundle.manifest),
          Date.now(),
          canonical(result),
        );
      this.db
        .prepare(
          "INSERT INTO bundle_heads VALUES(?,?) ON CONFLICT(provider) DO UPDATE SET digest=excluded.digest",
        )
        .run(provider, bundle.digest);
    }
    if (!artifact) {
      this.db
        .prepare("INSERT INTO bundle_artifacts VALUES(?,?,?)")
        .run(provider, bundle.digest, bundle_bytes(bundle).toString("utf8"));
    } else {
      // Replays verify persisted content rather than silently repairing corruption.
      this.read_bundle_snapshot(provider, bundle.digest);
    }
    return result;
  }
  #disable_publication(source) {
    this.db
      .prepare(
        "UPDATE bundle_publications SET disabled=1 WHERE provider IN (SELECT provider FROM bundle_documents WHERE source=?)",
      )
      .run(source);
  }
  #snapshot_body(row, provider, expected) {
    if (!row) fail("BUNDLE_SNAPSHOT_NOT_FOUND");
    try {
      if (
        typeof row.body !== "string" ||
        Buffer.byteLength(row.body) > MAX_BUNDLE_BYTES
      )
        throw new Error();
      const bundle = validate_bundle(JSON.parse(row.body));
      if (
        bundle.digest !== expected ||
        bundle.manifest.provider.provider_id !== provider ||
        canonical(bundle.manifest) !== row.manifest
      )
        throw new Error();
      return bundle;
    } catch {
      fail("CORRUPT_BUNDLE_SNAPSHOT");
    }
  }
  /** Explicit historical read: detached, validated, complete content from one immutable row. */
  read_bundle_snapshot(provider, selected) {
    label(provider);
    bundle_digest(selected);
    if (this.db.prepare("PRAGMA user_version").get().user_version < 3)
      fail("BUNDLE_SNAPSHOT_NOT_FOUND");
    const row = this.db
      .prepare(
        `SELECT CASE WHEN length(CAST(a.body AS BLOB))<=${MAX_BUNDLE_BYTES} THEN a.body END AS body,s.manifest FROM bundle_artifacts a JOIN bundle_snapshots s ON a.provider=s.provider AND a.digest=s.digest WHERE a.provider=? AND a.digest=?`,
      )
      .get(provider, selected);
    return this.#snapshot_body(row, provider, selected);
  }
  /** CAS publication never selects a skipped, overridden or incomplete staging result. */
  publish_bundle(provider, selected, expected = null) {
    label(provider);
    bundle_digest(selected);
    if (expected !== null) bundle_digest(expected);
    return this.transaction(() =>
      this.#publish_bundle(provider, selected, expected),
    );
  }
  #publish_bundle(provider, selected, expected) {
    const current = this.db
      .prepare("SELECT * FROM bundle_publications WHERE provider=?")
      .get(provider);
    if ((current?.digest ?? null) !== expected)
      fail("BUNDLE_PUBLICATION_CONFLICT");
    const head = this.db
      .prepare("SELECT digest FROM bundle_heads WHERE provider=?")
      .get(provider);
    if (head?.digest !== selected) fail("STALE_KNOWLEDGE_BUNDLE");
    const bundle = this.read_bundle_snapshot(provider, selected);
    for (let index = 0; index < bundle.documents.length; index++) {
      const metadata = bundle.manifest.documents[index];
      const owned = this.db
        .prepare("SELECT * FROM bundle_documents WHERE source=?")
        .get(metadata.source);
      const source = this.current(metadata.source);
      if (
        !owned ||
        owned.provider !== provider ||
        owned.document !== metadata.id ||
        owned.overridden ||
        owned.managed_retired ||
        owned.revision !== metadata.revision ||
        !source ||
        source.retired ||
        source.current_revision !== metadata.revision
      )
        fail("BUNDLE_PUBLICATION_INCOMPLETE");
      const document = this.get(metadata.source, metadata.revision);
      if (
        document.digest !== metadata.digest ||
        document.text !== bundle.documents[index].text
      )
        fail("CORRUPT_BUNDLE_SNAPSHOT");
    }
    if (current?.digest === selected && !current.disabled)
      return {
        provider,
        digest: selected,
        published_at: current.published_at,
        replayed: true,
        documents: bundle.documents.length,
      };
    if (this.free_disk() < 1024 ** 3) fail("DISK_PRESSURE");
    const published_at = Date.now();
    this.db
      .prepare(
        "INSERT INTO bundle_publications VALUES(?,?,?,0) ON CONFLICT(provider) DO UPDATE SET digest=excluded.digest,published_at=excluded.published_at,disabled=0",
      )
      .run(provider, selected, published_at);
    return {
      provider,
      digest: selected,
      published_at,
      replayed: false,
      documents: bundle.documents.length,
    };
  }
  /** Automatic refresh owns only its recorded head; stage and publish succeed together. */
  refresh_bundle(input) {
    const bundle = validate_bundle(
      JSON.parse(JSON.stringify(validate_bundle(input))),
    );
    const provider = bundle.manifest.provider.provider_id;
    return this.transaction(() => {
      const managed = this.db
        .prepare("SELECT digest FROM bundle_refresh WHERE provider=?")
        .get(provider);
      const publication = this.db
        .prepare("SELECT * FROM bundle_publications WHERE provider=?")
        .get(provider);
      const head = this.db
        .prepare("SELECT digest FROM bundle_heads WHERE provider=?")
        .get(provider);
      const expected = managed?.digest ?? bundle.digest;
      if (
        publication?.disabled ||
        (publication && publication.digest !== expected) ||
        (managed && !publication) ||
        (head && head.digest !== expected)
      )
        return { state: "operator_override", changed: false };
      if (managed?.digest !== bundle.digest && this.free_disk() < 1024 ** 3)
        fail("DISK_PRESSURE");
      const reconciliation = this.#reconcile_bundle(bundle);
      const published = this.#publish_bundle(
        provider,
        bundle.digest,
        publication?.digest ?? null,
      );
      if (managed?.digest !== bundle.digest)
        this.db
          .prepare(
            "INSERT INTO bundle_refresh VALUES(?,?) ON CONFLICT(provider) DO UPDATE SET digest=excluded.digest",
          )
          .run(provider, bundle.digest);
      return {
        state: "ready",
        changed: !published.replayed || managed?.digest !== bundle.digest,
        digest: bundle.digest,
        reconciliation,
      };
    });
  }
  bundle_refresh_status(provider) {
    label(provider);
    if (this.db.prepare("PRAGMA user_version").get().user_version < 4)
      return null;
    return (
      this.db
        .prepare("SELECT digest FROM bundle_refresh WHERE provider=?")
        .get(provider) ?? null
    );
  }
  /** Explicit operator handoff; adopt only an already-published, fully verified head. */
  adopt_bundle_refresh(provider, selected, expected = null) {
    label(provider);
    bundle_digest(selected);
    if (expected !== null) bundle_digest(expected);
    return this.transaction(() => {
      const managed = this.bundle_refresh_status(provider);
      if ((managed?.digest ?? null) !== expected)
        fail("BUNDLE_REFRESH_CONFLICT");
      const publication = this.db
        .prepare(
          "SELECT digest,disabled FROM bundle_publications WHERE provider=?",
        )
        .get(provider);
      if (
        !publication ||
        publication.disabled ||
        publication.digest !== selected
      )
        fail("BUNDLE_REFRESH_CONFLICT");
      this.#publish_bundle(provider, selected, selected);
      if (managed?.digest !== selected) {
        if (this.free_disk() < 1024 ** 3) fail("DISK_PRESSURE");
        this.db
          .prepare(
            "INSERT INTO bundle_refresh VALUES(?,?) ON CONFLICT(provider) DO UPDATE SET digest=excluded.digest",
          )
          .run(provider, selected);
      }
      return { digest: selected, replayed: managed?.digest === selected };
    });
  }
  /** A single SELECT pins the published pointer and every document to one generation. */
  published_bundle(provider) {
    label(provider);
    if (this.db.prepare("PRAGMA user_version").get().user_version < 3)
      fail("BUNDLE_PUBLICATION_NOT_FOUND");
    const row = this.db
      .prepare(
        `SELECT p.digest,p.published_at,p.disabled,CASE WHEN length(CAST(a.body AS BLOB))<=${MAX_BUNDLE_BYTES} THEN a.body END AS body,s.manifest FROM bundle_publications p LEFT JOIN bundle_artifacts a ON p.provider=a.provider AND p.digest=a.digest LEFT JOIN bundle_snapshots s ON p.provider=s.provider AND p.digest=s.digest WHERE p.provider=?`,
      )
      .get(provider);
    if (!row) fail("BUNDLE_PUBLICATION_NOT_FOUND");
    if (row.disabled) fail("BUNDLE_PUBLICATION_DISABLED");
    return {
      published_at: row.published_at,
      bundle: this.#snapshot_body(row, provider, row.digest),
    };
  }
  bundle_status(provider) {
    label(provider);
    if (this.db.prepare("PRAGMA user_version").get().user_version < 2)
      return null;
    const row = this.db
      .prepare(
        "SELECT s.* FROM bundle_snapshots s JOIN bundle_heads h ON s.provider=h.provider AND s.digest=h.digest WHERE s.provider=?",
      )
      .get(provider);
    if (!row) return null;
    return {
      provider,
      digest: row.digest,
      reconciled_at: row.reconciled_at,
      manifest: JSON.parse(row.manifest),
      summary: JSON.parse(row.summary),
      snapshots: this.db
        .prepare("SELECT count(*) AS n FROM bundle_snapshots WHERE provider=?")
        .get(provider).n,
      publication:
        this.db.prepare("PRAGMA user_version").get().user_version >= 3
          ? (this.db
              .prepare(
                "SELECT digest,published_at,disabled FROM bundle_publications WHERE provider=?",
              )
              .get(provider) ?? null)
          : null,
    };
  }
  snapshot(operation) {
    this.db.exec("BEGIN");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }
  status() {
    return {
      contract_version: 1,
      state: "ready",
      sources: this.db
        .prepare("SELECT count(*) AS n FROM sources WHERE retired=0")
        .get().n,
      revisions: this.db.prepare("SELECT count(*) AS n FROM revisions").get().n,
      revision_limit: 1000,
      document_byte_limit: 65536,
      search_limit: 10,
    };
  }
  close() {
    this.app_reference_refresh?.close();
    this.db?.close();
    this.db = null;
  }
}
