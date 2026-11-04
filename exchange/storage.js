import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { uuid } from "../inference/contracts.js";
import { secure_directory } from "../peers/files.js";
import { ArtifactFiles } from "./artifacts.js";
import {
  ArtifactError,
  deny,
  integer,
  PAGE_SIZE,
  parse_record,
  record_bytes,
} from "./contracts.js";
import { empty_metadata, metadata_contract } from "./metadata.js";

const REASONS = new Set([
  "INVALID_ARTIFACT",
  "HASH_MISMATCH",
  "ORIGIN_CONFLICT",
  "INVALID_MANIFEST",
  "INVALID_METADATA",
  "PEER_PROTOCOL_ERROR",
]);
export class ExchangeStore {
  constructor(
    directory,
    node_id,
    {
      max_records = 1000,
      retention_ms = 7 * 86400000,
      min_disk_bytes = 1024 ** 3,
    } = {},
  ) {
    this.directory = directory;
    this.node_id = node_id;
    this.max_records = max_records;
    this.retention_ms = retention_ms;
    this.min_disk_bytes = min_disk_bytes;
    this.failed = false;
    this.closed = false;
    this.inventory = empty_metadata();
    if (!uuid(node_id)) deny("EXCHANGE_UNAVAILABLE", 503);
    secure_directory(directory);
    this.files = new ArtifactFiles(path.join(directory, "artifacts"));
    const filename = path.join(directory, "exchange.sqlite");
    if (fs.existsSync(filename) && fs.lstatSync(filename).isSymbolicLink())
      deny("EXCHANGE_UNAVAILABLE", 503);
    try {
      this.db = new DatabaseSync(filename);
      this.db.exec(
        "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT; PRAGMA max_page_count=8192;",
      );
      if (process.platform !== "win32") fs.chmodSync(filename, 0o600);
      const version = this.db.prepare("PRAGMA user_version").get().user_version;
      if (![0, 1].includes(version)) deny("EXCHANGE_UNAVAILABLE", 503);
      if (!version)
        this.db.exec(`BEGIN;
        CREATE TABLE settings(id INTEGER PRIMARY KEY CHECK(id=1), node TEXT NOT NULL, origin_epoch TEXT NOT NULL, origin_sequence INTEGER NOT NULL, catalog_epoch TEXT NOT NULL);
        CREATE TABLE records(sequence INTEGER PRIMARY KEY AUTOINCREMENT, digest TEXT UNIQUE NOT NULL, size INTEGER NOT NULL,
          origin TEXT NOT NULL, epoch TEXT NOT NULL, origin_sequence INTEGER NOT NULL, acquired INTEGER NOT NULL, source TEXT,
          UNIQUE(origin, epoch, origin_sequence));
        CREATE TABLE exports(job TEXT PRIMARY KEY, digest TEXT);
        CREATE TABLE cursors(peer TEXT PRIMARY KEY, epoch TEXT NOT NULL, cursor INTEGER NOT NULL);
        CREATE TABLE metadata(peer TEXT PRIMARY KEY, acquired INTEGER NOT NULL, data TEXT NOT NULL);
        CREATE TABLE quarantine(sequence INTEGER PRIMARY KEY AUTOINCREMENT, peer TEXT NOT NULL, reason TEXT NOT NULL, acquired INTEGER NOT NULL);
        PRAGMA user_version=1; COMMIT;`);
      if (!this.db.prepare("SELECT id FROM settings").get())
        this.db
          .prepare("INSERT INTO settings VALUES(1,?,?,0,?)")
          .run(node_id, randomUUID(), randomUUID());
      if (this.settings().node !== node_id) deny("EXCHANGE_UNAVAILABLE", 503);
      // Verify referenced content before advertising any records. Orphans are safe
      // to remove: files are published before their SQLite transaction commits.
      for (const row of this.rows())
        parse_record(this.files.read(row.digest), this.entry(row));
      this.maintain();
    } catch (error) {
      this.db?.close();
      throw error;
    }
  }
  guard(operation) {
    if (this.failed || this.closed) deny("EXCHANGE_UNAVAILABLE", 503);
    try {
      return operation();
    } catch (error) {
      if (
        error instanceof ArtifactError &&
        !["EXCHANGE_CORRUPT", "EXCHANGE_UNAVAILABLE"].includes(error.code)
      )
        throw error;
      this.failed = true;
      deny("EXCHANGE_UNAVAILABLE", 503);
    }
  }
  settings() {
    return this.db.prepare("SELECT * FROM settings WHERE id=1").get();
  }
  rows() {
    return this.db.prepare("SELECT * FROM records ORDER BY sequence").all();
  }
  entry(row) {
    return {
      sequence: row.sequence,
      digest: row.digest,
      size_bytes: row.size,
      origin: {
        node_id: row.origin,
        epoch: row.epoch,
        sequence: row.origin_sequence,
      },
    };
  }
  transaction(operation) {
    this.db.exec("BEGIN");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  capacity() {
    const stats = fs.statfsSync(this.directory);
    if (Number(stats.bavail) * Number(stats.bsize) < this.min_disk_bytes)
      deny("DISK_PRESSURE", 503);
  }
  has_export(job) {
    return !!this.db.prepare("SELECT job FROM exports WHERE job=?").get(job);
  }
  reject_export(job) {
    this.guard(() =>
      this.db.prepare("INSERT OR IGNORE INTO exports VALUES(?,NULL)").run(job),
    );
  }
  publish(job, payload) {
    return this.guard(() => {
      if (this.has_export(job)) return false;
      this.capacity();
      const settings = this.settings();
      if (!integer(settings.origin_sequence + 1, 1))
        deny("EXCHANGE_UNAVAILABLE", 503);
      const bytes = record_bytes({
        ...payload,
        origin: {
          node_id: this.node_id,
          epoch: settings.origin_epoch,
          sequence: settings.origin_sequence + 1,
        },
      });
      const value = JSON.parse(bytes);
      const digest = this.files.write(bytes);
      this.transaction(() => {
        this.insert(value, digest, bytes.length, null);
        this.db
          .prepare("UPDATE settings SET origin_sequence=? WHERE id=1")
          .run(value.origin.sequence);
        this.db.prepare("INSERT INTO exports VALUES(?,?)").run(job, digest);
      });
      return true;
    });
  }
  insert(value, digest, size, source) {
    this.db
      .prepare(
        "INSERT INTO records(digest,size,origin,epoch,origin_sequence,acquired,source) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        digest,
        size,
        value.origin.node_id,
        value.origin.epoch,
        value.origin.sequence,
        Date.now(),
        source,
      );
  }
  disposition(entry) {
    return this.guard(() => {
      const row = this.db
        .prepare(
          "SELECT * FROM records WHERE origin=? AND epoch=? AND origin_sequence=?",
        )
        .get(entry.origin.node_id, entry.origin.epoch, entry.origin.sequence);
      if (row)
        return row.digest === entry.digest && row.size === entry.size_bytes
          ? "duplicate"
          : "conflict";
      return entry.origin.node_id === this.node_id ? "own" : "missing";
    });
  }
  import(peer, entry, bytes, catalog_epoch) {
    return this.guard(() => {
      const value = parse_record(bytes, entry);
      const state = this.disposition(entry);
      if (state === "conflict") deny("ORIGIN_CONFLICT");
      if (state === "missing") {
        this.capacity();
        this.files.write(bytes);
      }
      this.transaction(() => {
        if (state === "missing")
          this.insert(value, entry.digest, bytes.length, peer);
        this.checkpoint(peer, catalog_epoch, entry.sequence);
      });
      return state === "missing";
    });
  }
  manifest(epoch, cursor) {
    return this.guard(() => {
      const settings = this.settings();
      const head =
        this.db
          .prepare("SELECT seq FROM sqlite_sequence WHERE name='records'")
          .get()?.seq || 0;
      if (
        (epoch !== "start" && epoch !== settings.catalog_epoch) ||
        cursor > head
      )
        deny("RESNAPSHOT_REQUIRED", 409);
      const rows = this.db
        .prepare(
          "SELECT * FROM records WHERE sequence>? ORDER BY sequence LIMIT ?",
        )
        .all(cursor, PAGE_SIZE + 1);
      return {
        contract_version: 1,
        epoch: settings.catalog_epoch,
        cursor,
        next_cursor: rows.slice(0, PAGE_SIZE).at(-1)?.sequence || cursor,
        has_more: rows.length > PAGE_SIZE,
        entries: rows.slice(0, PAGE_SIZE).map((row) => this.entry(row)),
      };
    });
  }
  blob(digest) {
    return this.guard(() => {
      const row = this.db
        .prepare("SELECT * FROM records WHERE digest=?")
        .get(digest);
      if (!row) deny("ARTIFACT_NOT_FOUND", 404);
      const bytes = this.files.read(digest);
      try {
        parse_record(bytes, this.entry(row));
      } catch {
        deny("EXCHANGE_CORRUPT", 503);
      }
      return bytes;
    });
  }
  inspect(digest) {
    return this.guard(() => {
      const row = this.db
        .prepare("SELECT * FROM records WHERE digest=?")
        .get(digest);
      if (!row) deny("ARTIFACT_NOT_FOUND", 404);
      return {
        contract_version: 1,
        trust: "untrusted_evidence",
        received_from: row.source,
        artifact: parse_record(this.blob(digest), this.entry(row)),
      };
    });
  }
  cursor(peer) {
    return this.guard(
      () =>
        this.db
          .prepare("SELECT epoch,cursor FROM cursors WHERE peer=?")
          .get(peer) || { epoch: "start", cursor: 0 },
    );
  }
  checkpoint(peer, epoch, cursor) {
    if (!uuid(peer) || !uuid(epoch) || !integer(cursor)) deny();
    this.guard(() =>
      this.db
        .prepare(
          "INSERT INTO cursors VALUES(?,?,?) ON CONFLICT(peer) DO UPDATE SET epoch=excluded.epoch,cursor=excluded.cursor",
        )
        .run(peer, epoch, cursor),
    );
  }
  reset_cursor(peer) {
    this.guard(() =>
      this.db.prepare("DELETE FROM cursors WHERE peer=?").run(peer),
    );
  }
  quarantine(peer, reason) {
    return this.guard(() => {
      if (!uuid(peer)) deny();
      this.db
        .prepare("INSERT INTO quarantine(peer,reason,acquired) VALUES(?,?,?)")
        .run(
          peer,
          REASONS.has(reason) ? reason : "INVALID_ARTIFACT",
          Date.now(),
        );
      this.db.exec(
        "DELETE FROM quarantine WHERE sequence NOT IN (SELECT sequence FROM quarantine ORDER BY sequence DESC LIMIT 100)",
      );
    });
  }
  prune_exports(jobs) {
    for (const row of this.db.prepare("SELECT job FROM exports").all())
      if (!jobs.has(row.job))
        this.db.prepare("DELETE FROM exports WHERE job=?").run(row.job);
  }
  retain_peers(ids) {
    this.guard(() => {
      for (const table of ["cursors", "metadata"])
        for (const row of this.db.prepare(`SELECT peer FROM ${table}`).all())
          if (!ids.has(row.peer))
            this.db.prepare(`DELETE FROM ${table} WHERE peer=?`).run(row.peer);
    });
  }
  save_metadata(peer, value) {
    this.guard(() =>
      this.db
        .prepare(
          "INSERT INTO metadata VALUES(?,?,?) ON CONFLICT(peer) DO UPDATE SET acquired=excluded.acquired,data=excluded.data",
        )
        .run(peer, Date.now(), JSON.stringify(metadata_contract(value))),
    );
  }
  metadata() {
    return this.guard(() => metadata_contract(this.inventory));
  }
  inventories() {
    return this.guard(() => ({
      contract_version: 1,
      peers: this.db
        .prepare(
          "SELECT peer,acquired,data FROM metadata ORDER BY peer LIMIT 16",
        )
        .all()
        .map((row) => ({
          peer_id: row.peer,
          acquired_at: row.acquired,
          metadata: metadata_contract(JSON.parse(row.data)),
        })),
    }));
  }
  status() {
    return this.guard(() => ({
      state: "ready",
      local_records: this.db
        .prepare("SELECT count(*) AS n FROM records WHERE source IS NULL")
        .get().n,
      imported_records: this.db
        .prepare("SELECT count(*) AS n FROM records WHERE source IS NOT NULL")
        .get().n,
      quarantined_records: this.db
        .prepare("SELECT count(*) AS n FROM quarantine")
        .get().n,
    }));
  }
  maintain(now = Date.now()) {
    return this.guard(() => {
      const remove = this.db
        .prepare(
          "SELECT sequence FROM records ORDER BY acquired DESC,sequence DESC",
        )
        .all()
        .slice(this.max_records);
      const expired = this.db
        .prepare("SELECT sequence FROM records WHERE acquired<?")
        .all(now - this.retention_ms);
      const sequences = new Set(
        [...remove, ...expired].map((row) => row.sequence),
      );
      if (sequences.size)
        this.transaction(() => {
          for (const seq of sequences)
            this.db.prepare("DELETE FROM records WHERE sequence=?").run(seq);
          this.db
            .prepare("UPDATE settings SET catalog_epoch=? WHERE id=1")
            .run(randomUUID());
        });
      this.files.prune(new Set(this.rows().map((row) => `${row.digest}.json`)));
    });
  }
  close() {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }
}
