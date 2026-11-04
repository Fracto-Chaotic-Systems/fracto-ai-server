import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { secure_directory } from "../peers/files.js";
import { fail } from "./contracts.js";

export const active = (row) =>
  row.reconciling ||
  ["prepared", "submitting", "accepted", "cancelling"].includes(row.state);
export class DelegationStore {
  constructor(directory, node_id) {
    this.directory = directory;
    this.failed = false;
    this.closed = false;
    secure_directory(directory);
    const filename = path.join(directory, "delegation.sqlite");
    if (fs.existsSync(filename) && fs.lstatSync(filename).isSymbolicLink())
      fail("DELEGATION_UNAVAILABLE", 503);
    try {
      this.db = new DatabaseSync(filename);
      this.db.exec(
        "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT; PRAGMA max_page_count=8192;",
      );
      if (process.platform !== "win32") fs.chmodSync(filename, 0o600);
      const version = this.db.prepare("PRAGMA user_version").get().user_version;
      if (![0, 1].includes(version)) fail("DELEGATION_UNAVAILABLE", 503);
      if (!version)
        this.db.exec(`BEGIN;
        CREATE TABLE owner(node TEXT NOT NULL);
        CREATE TABLE outgoing(id TEXT PRIMARY KEY, idem TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
        PRAGMA user_version=1; COMMIT;`);
      const owner = this.db.prepare("SELECT node FROM owner").get();
      if (!owner) this.db.prepare("INSERT INTO owner VALUES(?)").run(node_id);
      else if (owner.node !== node_id) fail("DELEGATION_UNAVAILABLE", 503);
      for (const row of this.all())
        if (row.state === "submitting") {
          row.state = "unknown";
          row.reconciling = true;
          row.error = "OUTCOME_UNKNOWN";
          row.next_at = 0;
          this.save(row);
        }
    } catch (error) {
      this.db?.close();
      throw error;
    }
  }
  guard(operation) {
    if (this.failed || this.closed) fail("DELEGATION_UNAVAILABLE", 503);
    try {
      return operation();
    } catch (error) {
      this.failed = true;
      fail("DELEGATION_UNAVAILABLE", 503);
    }
  }
  all() {
    return this.guard(() =>
      this.db
        .prepare("SELECT data FROM outgoing ORDER BY rowid")
        .all()
        .map((row) => JSON.parse(row.data)),
    );
  }
  get(id) {
    return this.guard(() => {
      const row = this.db
        .prepare("SELECT data FROM outgoing WHERE id=?")
        .get(id);
      return row ? JSON.parse(row.data) : null;
    });
  }
  by_key(key) {
    return this.guard(() => {
      const row = this.db
        .prepare("SELECT data FROM outgoing WHERE idem=?")
        .get(key);
      return row ? JSON.parse(row.data) : null;
    });
  }
  insert(row) {
    this.guard(() =>
      this.db
        .prepare("INSERT INTO outgoing VALUES(?,?,?)")
        .run(row.id, row.idempotency_key, JSON.stringify(row)),
    );
  }
  save(row) {
    this.guard(() =>
      this.db
        .prepare("UPDATE outgoing SET data=? WHERE id=?")
        .run(JSON.stringify(row), row.id),
    );
  }
  capacity() {
    const stats = fs.statfsSync(this.directory);
    if (Number(stats.bavail) * Number(stats.bsize) < 1024 ** 3)
      fail("DISK_PRESSURE", 503);
    if (this.all().filter(active).length >= 16) fail("QUEUE_FULL", 429);
  }
  maintain(now = Date.now()) {
    const finished = this.all()
      .filter((row) => !active(row))
      .sort((a, b) => b.finished_at - a.finished_at);
    this.guard(() => {
      for (let i = 0; i < finished.length; i++)
        if (i >= 1000 || finished[i].finished_at < now - 7 * 86400000)
          this.db
            .prepare("DELETE FROM outgoing WHERE id=?")
            .run(finished[i].id);
    });
  }
  close() {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }
}
