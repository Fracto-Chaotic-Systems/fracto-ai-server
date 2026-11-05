import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { secure_directory } from "../peers/files.js";
import { uuid } from "../inference/contracts.js";
import { canonical } from "../skills/contracts.js";
import {
  fail,
  digest,
  integer,
  kinds,
  payload,
  encode,
  parse,
  bytes_hash,
  fresh_epoch,
} from "./contracts.js";

const regular = (file) => {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink())
    fail("DISTRIBUTION_UNAVAILABLE", 503);
};
export class DistributionStore {
  constructor(
    directory,
    node_id,
    {
      read_only = false,
      free_disk = () => {
        const stat = fs.statfsSync(directory);
        return Number(stat.bavail) * Number(stat.bsize);
      },
    } = {},
  ) {
    this.directory = directory;
    this.node_id = node_id;
    this.read_only = read_only;
    this.free_disk = free_disk;
    this.closed = false;
    if (!uuid(node_id)) fail("DISTRIBUTION_UNAVAILABLE", 503);
    try {
      if (read_only) {
        const stat = fs.lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink())
          fail("DISTRIBUTION_UNAVAILABLE", 503);
      } else secure_directory(directory);
      const file = path.join(directory, "distribution.sqlite");
      for (const suffix of ["", "-journal", "-wal", "-shm"])
        if (fs.existsSync(file + suffix)) regular(file + suffix);
      if (read_only) regular(file);
      this.db = new DatabaseSync(file, { readOnly: read_only });
      this.db.exec("PRAGMA busy_timeout=2000");
      if (read_only) {
        this.db.exec("PRAGMA query_only=ON");
        if (this.db.prepare("PRAGMA user_version").get().user_version !== 1)
          fail("UNKNOWN_DISTRIBUTION_SCHEMA", 503);
      } else {
        if (process.platform !== "win32") fs.chmodSync(file, 0o600);
        this.db.exec(
          "PRAGMA journal_mode=DELETE;PRAGMA synchronous=FULL;PRAGMA max_page_count=32768",
        );
        this.transaction(() => {
          if (
            ![0, 1].includes(
              this.db.prepare("PRAGMA user_version").get().user_version,
            )
          )
            fail("UNKNOWN_DISTRIBUTION_SCHEMA", 503);
          this.db
            .exec(`CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1),node TEXT NOT NULL,origin_epoch TEXT NOT NULL,origin_sequence INTEGER NOT NULL,feed_epoch TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS records(digest TEXT PRIMARY KEY,kind TEXT NOT NULL,node TEXT NOT NULL,epoch TEXT NOT NULL,origin_sequence INTEGER NOT NULL,body BLOB NOT NULL,sender TEXT,acquired INTEGER NOT NULL,UNIQUE(node,epoch,origin_sequence));
            CREATE TABLE IF NOT EXISTS feed(sequence INTEGER PRIMARY KEY AUTOINCREMENT,digest TEXT UNIQUE NOT NULL);
            CREATE TABLE IF NOT EXISTS cursors(peer TEXT NOT NULL,kind TEXT NOT NULL,epoch TEXT NOT NULL,cursor INTEGER NOT NULL,PRIMARY KEY(peer,kind));
            CREATE TABLE IF NOT EXISTS quarantine(sequence INTEGER PRIMARY KEY AUTOINCREMENT,peer TEXT NOT NULL,reason TEXT NOT NULL,at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS adoptions(digest TEXT NOT NULL,target TEXT NOT NULL,expected TEXT,state TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(digest,target));
            PRAGMA user_version=1;`);
          this.db
            .prepare(
              "INSERT INTO settings VALUES(1,?,?,0,?) ON CONFLICT(id) DO NOTHING",
            )
            .run(node_id, fresh_epoch(), fresh_epoch());
        });
      }
      if (this.settings().node !== node_id)
        fail("DISTRIBUTION_UNAVAILABLE", 503);
    } catch (error) {
      this.close();
      throw error;
    }
  }
  transaction(operation) {
    if (this.read_only || this.closed) fail("DISTRIBUTION_UNAVAILABLE", 503);
    if (this.free_disk() < 1024 ** 3) fail("DISK_PRESSURE", 503);
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
  settings() {
    return this.db.prepare("SELECT * FROM settings WHERE id=1").get();
  }
  get(checksum) {
    if (!digest(checksum)) fail();
    const row = this.db
      .prepare("SELECT * FROM records WHERE digest=?")
      .get(checksum);
    if (!row) fail("DISTRIBUTION_NOT_FOUND", 404);
    const bytes = Buffer.from(row.body);
    if (bytes_hash(bytes) !== checksum) fail("CORRUPT_DISTRIBUTION", 503);
    const value = parse(bytes);
    if (
      value.kind !== row.kind ||
      value.origin.node_id !== row.node ||
      value.origin.epoch !== row.epoch ||
      value.origin.sequence !== row.origin_sequence
    )
      fail("CORRUPT_DISTRIBUTION", 503);
    return {
      digest: checksum,
      record: value,
      immediate_sender: row.sender,
      acquired: row.acquired,
      evidence_only: true,
      origin_attested: false,
    };
  }
  disposition(entry) {
    const row = this.db
      .prepare(
        "SELECT digest FROM records WHERE node=? AND epoch=? AND origin_sequence=?",
      )
      .get(entry.origin.node_id, entry.origin.epoch, entry.origin.sequence);
    return row
      ? row.digest === entry.digest
        ? "known"
        : "conflict"
      : "missing";
  }
  insert(value, bytes, checksum, sender) {
    const disposition = this.disposition({
      origin: value.origin,
      digest: checksum,
    });
    if (disposition === "conflict") fail("ORIGIN_CONFLICT");
    if (disposition === "known") {
      this.get(checksum);
      return;
    }
    if (sender && value.origin.node_id === this.node_id)
      fail("ORIGIN_CONFLICT");
    if (this.db.prepare("SELECT count(*) AS n FROM records").get().n >= 1000)
      fail("DISTRIBUTION_CAPACITY", 503);
    this.db
      .prepare("INSERT INTO records VALUES(?,?,?,?,?,?,?,?)")
      .run(
        checksum,
        value.kind,
        value.origin.node_id,
        value.origin.epoch,
        value.origin.sequence,
        bytes,
        sender,
        Date.now(),
      );
  }
  publish(kind, body) {
    const clean = payload(kind, body);
    return this.transaction(() => {
      // Idempotent local publication of the same payload; do not mint new origins.
      const existing = this.db
        .prepare("SELECT digest FROM records WHERE node=? AND kind=?")
        .all(this.node_id, kind)
        .find(
          (row) =>
            canonical(this.get(row.digest).record.payload) === canonical(clean),
        );
      if (existing) {
        this.db
          .prepare(
            "INSERT INTO feed(digest) VALUES(?) ON CONFLICT(digest) DO NOTHING",
          )
          .run(existing.digest);
        return this.get(existing.digest);
      }
      const state = this.settings();
      if (!integer(state.origin_sequence + 1))
        fail("DISTRIBUTION_CAPACITY", 503);
      const value = {
        contract_version: 1,
        kind,
        origin: {
          node_id: this.node_id,
          epoch: state.origin_epoch,
          sequence: state.origin_sequence + 1,
        },
        payload: clean,
      };
      const bytes = encode(value),
        checksum = bytes_hash(bytes);
      this.insert(value, bytes, checksum, null);
      this.db
        .prepare("UPDATE settings SET origin_sequence=? WHERE id=1")
        .run(value.origin.sequence);
      this.db.prepare("INSERT INTO feed(digest) VALUES(?)").run(checksum);
      return this.get(checksum);
    });
  }
  import(peer, kind, entry, bytes) {
    if (!uuid(peer) || !Object.hasOwn(kinds, kind)) fail();
    if (bytes_hash(bytes) !== entry.digest || bytes.length !== entry.bytes)
      fail("HASH_MISMATCH");
    const value = parse(bytes);
    if (
      value.kind !== kind ||
      canonical(value.origin) !== canonical(entry.origin)
    )
      fail();
    return this.transaction(() => {
      this.insert(value, bytes, entry.digest, peer);
      return this.get(entry.digest);
    });
  }
  relay(checksum) {
    return this.transaction(() => {
      this.get(checksum);
      this.db
        .prepare(
          "INSERT INTO feed(digest) VALUES(?) ON CONFLICT(digest) DO NOTHING",
        )
        .run(checksum);
      return { digest: checksum, published: true };
    });
  }
  withdraw(checksum) {
    return this.transaction(() => {
      this.get(checksum);
      this.db.prepare("DELETE FROM feed WHERE digest=?").run(checksum);
      this.db
        .prepare("UPDATE settings SET feed_epoch=? WHERE id=1")
        .run(fresh_epoch());
      return { digest: checksum, published: false };
    });
  }
  manifest(kind, epoch, cursor) {
    if (!Object.hasOwn(kinds, kind) || !integer(cursor)) fail();
    const state = this.settings();
    const high = this.db
      .prepare("SELECT coalesce(max(sequence),0) AS n FROM feed")
      .get().n;
    if ((epoch !== "start" && epoch !== state.feed_epoch) || cursor > high)
      fail("RESNAPSHOT_REQUIRED", 409);
    const rows = this.db
      .prepare(
        "SELECT f.sequence,r.digest,length(r.body) AS bytes FROM feed f JOIN records r ON f.digest=r.digest WHERE r.kind=? AND f.sequence>? ORDER BY f.sequence LIMIT 5",
      )
      .all(kind, cursor);
    const entries = rows
      .slice(0, 4)
      .map((row) => ({ ...row, origin: this.get(row.digest).record.origin }));
    return {
      contract_version: 1,
      kind,
      epoch: state.feed_epoch,
      entries,
      next_cursor: entries.at(-1)?.sequence ?? high,
      has_more: rows.length > 4,
    };
  }
  blob(kind, checksum) {
    const item = this.get(checksum);
    if (
      item.record.kind !== kind ||
      !this.db.prepare("SELECT sequence FROM feed WHERE digest=?").get(checksum)
    )
      fail("DISTRIBUTION_NOT_FOUND", 404);
    return encode(item.record);
  }
  cursor(peer, kind) {
    return (
      this.db
        .prepare("SELECT epoch,cursor FROM cursors WHERE peer=? AND kind=?")
        .get(peer, kind) ?? { epoch: "start", cursor: 0 }
    );
  }
  checkpoint(peer, kind, epoch, cursor) {
    if (
      !uuid(peer) ||
      !Object.hasOwn(kinds, kind) ||
      !uuid(epoch) ||
      !integer(cursor)
    )
      fail();
    this.transaction(() =>
      this.db
        .prepare(
          "INSERT INTO cursors VALUES(?,?,?,?) ON CONFLICT(peer,kind) DO UPDATE SET epoch=excluded.epoch,cursor=excluded.cursor",
        )
        .run(peer, kind, epoch, cursor),
    );
  }
  reset(peer, kind) {
    this.transaction(() =>
      this.db
        .prepare("DELETE FROM cursors WHERE peer=? AND kind=?")
        .run(peer, kind),
    );
  }
  retain(peers) {
    this.transaction(() => {
      for (const row of this.db
        .prepare("SELECT DISTINCT peer FROM cursors")
        .all())
        if (!peers.has(row.peer))
          this.db.prepare("DELETE FROM cursors WHERE peer=?").run(row.peer);
    });
  }
  quarantine(peer, reason) {
    const reasons = [
      "INVALID_DISTRIBUTION",
      "INVALID_DISTRIBUTION_MANIFEST",
      "HASH_MISMATCH",
      "ORIGIN_CONFLICT",
      "PEER_PROTOCOL_ERROR",
    ];
    if (!uuid(peer) || !reasons.includes(reason)) return;
    this.transaction(() => {
      this.db
        .prepare("INSERT INTO quarantine(peer,reason,at) VALUES(?,?,?)")
        .run(peer, reason, Date.now());
      this.db.exec(
        "DELETE FROM quarantine WHERE sequence NOT IN (SELECT sequence FROM quarantine ORDER BY sequence DESC LIMIT 100)",
      );
    });
  }
  begin_adoption(checksum, target, expected) {
    return this.transaction(() => {
      this.get(checksum);
      const old = this.db
        .prepare("SELECT * FROM adoptions WHERE digest=? AND target=?")
        .get(checksum, target);
      if (old) {
        if (old.expected !== expected) fail("ADOPTION_CONFLICT");
        return old;
      }
      if (
        this.db.prepare("SELECT count(*) AS n FROM adoptions").get().n >= 1000
      )
        fail("ADOPTION_CAPACITY", 503);
      this.db
        .prepare("INSERT INTO adoptions VALUES(?,?,?,'pending',?)")
        .run(checksum, target, expected, Date.now());
      return { state: "pending" };
    });
  }
  finish_adoption(checksum, target) {
    this.transaction(() =>
      this.db
        .prepare(
          "UPDATE adoptions SET state='completed' WHERE digest=? AND target=?",
        )
        .run(checksum, target),
    );
  }
  adoptions() {
    return this.db
      .prepare("SELECT * FROM adoptions ORDER BY at DESC LIMIT 20")
      .all();
  }
  list(after = "") {
    if (after && !digest(after)) fail();
    const rows = this.db
      .prepare(
        "SELECT r.digest,r.kind,r.node AS origin_node,r.epoch AS origin_epoch,r.origin_sequence,r.sender AS immediate_sender,r.acquired,EXISTS(SELECT 1 FROM feed WHERE digest=r.digest) AS published FROM records r WHERE r.digest>? ORDER BY r.digest LIMIT 21",
      )
      .all(after);
    return {
      items: rows.slice(0, 20),
      next_cursor: rows.length > 20 ? rows[19].digest : null,
    };
  }
  status() {
    return {
      contract_version: 1,
      state: "ready",
      records: this.db.prepare("SELECT count(*) AS n FROM records").get().n,
      published: this.db.prepare("SELECT count(*) AS n FROM feed").get().n,
      adoptions: this.db.prepare("SELECT count(*) AS n FROM adoptions").get().n,
      quarantined: this.db.prepare("SELECT count(*) AS n FROM quarantine").get()
        .n,
    };
  }
  close() {
    this.db?.close();
    this.db = null;
    this.closed = true;
  }
}
