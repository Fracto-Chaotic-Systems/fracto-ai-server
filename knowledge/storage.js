import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { secure_directory, write_bytes } from "../peers/files.js";

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
        if (this.db.prepare("PRAGMA user_version").get().user_version !== 1)
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
        if (![0, 1].includes(version)) fail("UNKNOWN_SCHEMA");
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS sources(source TEXT PRIMARY KEY, current_revision TEXT NOT NULL, retired INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE IF NOT EXISTS revisions(source TEXT NOT NULL, revision TEXT NOT NULL, digest TEXT NOT NULL, bytes INTEGER NOT NULL, ingested_at INTEGER NOT NULL, PRIMARY KEY(source, revision));
          CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(source UNINDEXED, revision UNINDEXED, chunk UNINDEXED, body);
          PRAGMA user_version=1;
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
    return this.transaction(() => {
      const current = this.db
        .prepare("SELECT * FROM sources WHERE source=?")
        .get(source);
      const previous = this.db
        .prepare("SELECT * FROM revisions WHERE source=? AND revision=?")
        .get(source, revision);
      if (previous) {
        if (previous.digest !== hash) fail("REVISION_CONFLICT");
        if (current.current_revision !== revision || current.retired)
          fail("CURRENT_REVISION_CONFLICT");
        this.get(source, revision);
        return { ...previous, replayed: true };
      }
      if ((current?.current_revision ?? null) !== expected)
        fail("CURRENT_REVISION_CONFLICT");
      if (
        this.db.prepare("SELECT count(*) AS n FROM revisions").get().n >= 1000
      )
        fail("KNOWLEDGE_CAPACITY");
      if (this.free_disk() < 1024 ** 3) fail("DISK_PRESSURE");
      const filename = path.join(this.documents, `${hash}.txt`);
      if (fs.existsSync(filename)) {
        if (regular(filename).size > 65536) fail("CORRUPT_DOCUMENT");
        if (digest(fs.readFileSync(filename)) !== hash)
          fail("CORRUPT_DOCUMENT");
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
    });
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
    this.db?.close();
    this.db = null;
  }
}
