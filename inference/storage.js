import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fail, hash } from "./contracts.js";

const terminal = ["completed", "failed", "cancelled", "expired", "interrupted"];
export const is_terminal = (state) => terminal.includes(state);

/** Single owner, local disk only. Rollback journaling deliberately avoids WAL. */
export class LocalStore {
  constructor(
    directory,
    { token, retention_ms = 7 * 86400000, max_records = 1000 } = {},
  ) {
    this.directory = path.resolve(directory);
    this.artifacts = path.join(this.directory, "artifacts");
    this.retention_ms = retention_ms;
    this.max_records = max_records;
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(this.directory).isSymbolicLink())
      fail("STORAGE_UNAVAILABLE", 503);
    if (process.platform === "win32") {
      const secured = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          path.join(import.meta.dirname, "secure_directory.ps1"),
          "-Directory",
          this.directory,
        ],
        { windowsHide: true, stdio: "ignore", timeout: 15000 },
      );
      if (secured.status !== 0) fail("STORAGE_UNAVAILABLE", 503);
    } else fs.chmodSync(this.directory, 0o700);
    fs.mkdirSync(this.artifacts, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(this.artifacts).isSymbolicLink())
      fail("STORAGE_UNAVAILABLE", 503);
    try {
      const filename = path.join(this.directory, "inference.sqlite");
      if (fs.existsSync(filename) && fs.lstatSync(filename).isSymbolicLink())
        fail("STORAGE_UNAVAILABLE", 503);
      this.db = new DatabaseSync(filename);
      this.db.exec(
        "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT; PRAGMA max_page_count=8192;",
      );
      if (process.platform !== "win32") fs.chmodSync(filename, 0o600);
      const version = this.db.prepare("PRAGMA user_version").get().user_version;
      if (version !== 0 && version !== 1) fail("STORAGE_UNAVAILABLE", 503);
      if (version === 0)
        this.db.exec(`BEGIN;
        CREATE TABLE jobs(id TEXT PRIMARY KEY, idem TEXT UNIQUE NOT NULL, fingerprint TEXT NOT NULL,
          state TEXT NOT NULL, created INTEGER NOT NULL, finished INTEGER, data TEXT NOT NULL);
        CREATE INDEX jobs_retention ON jobs(state, finished);
        CREATE TABLE peer_cursors(peer TEXT PRIMARY KEY, epoch TEXT NOT NULL, cursor INTEGER NOT NULL);
        PRAGMA user_version=1; COMMIT;`);
      const token_file = path.join(this.directory, "machine-token");
      if (token !== undefined && !/^[0-9a-f]{64}$/.test(token))
        fail("CONFIGURATION_ERROR", 503);
      if (!token) {
        try {
          fs.writeFileSync(token_file, randomBytes(32).toString("hex"), {
            flag: "wx",
            mode: 0o600,
          });
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
        }
        if (
          !fs.lstatSync(token_file).isFile() ||
          fs.lstatSync(token_file).isSymbolicLink()
        )
          fail("STORAGE_UNAVAILABLE", 503);
        token = fs.readFileSync(token_file, "utf8");
      }
      if (!/^[0-9a-f]{64}$/.test(token)) fail("STORAGE_UNAVAILABLE", 503);
      this.token = token;
    } catch (error) {
      this.db?.close();
      throw error;
    }
  }
  all() {
    return this.db
      .prepare("SELECT data FROM jobs ORDER BY created, rowid")
      .all()
      .map((r) => JSON.parse(r.data));
  }
  get(id) {
    const row = this.db.prepare("SELECT data FROM jobs WHERE id=?").get(id);
    return row ? JSON.parse(row.data) : null;
  }
  by_key(key) {
    const row = this.db.prepare("SELECT data FROM jobs WHERE idem=?").get(key);
    return row ? JSON.parse(row.data) : null;
  }
  insert(job) {
    this.db
      .prepare("INSERT INTO jobs VALUES(?,?,?,?,?,?,?)")
      .run(
        job.id,
        job.idempotency_key,
        job.fingerprint,
        job.state,
        job.created_at,
        job.finished_at,
        JSON.stringify(job),
      );
  }
  save(job) {
    this.db
      .prepare("UPDATE jobs SET state=?,finished=?,data=? WHERE id=?")
      .run(job.state, job.finished_at, JSON.stringify(job), job.id);
  }
  artifact(value) {
    const bytes = Buffer.from(JSON.stringify(value));
    if (bytes.length > 8192) fail("INVALID_OUTPUT", 502);
    const digest = hash(bytes);
    const target = path.join(this.artifacts, `${digest}.json`);
    if (fs.existsSync(target)) {
      this.read_artifact(digest);
      return digest;
    }
    const temporary = path.join(this.artifacts, `${randomUUID()}.tmp`);
    try {
      const fd = fs.openSync(temporary, "wx", 0o600);
      try {
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, target);
      // Windows cannot fsync a directory through Node. File bytes are synced;
      // recovery verifies every referenced hash rather than assuming publication.
      if (process.platform !== "win32") {
        const directory = fs.openSync(this.artifacts, "r");
        try {
          fs.fsyncSync(directory);
        } finally {
          fs.closeSync(directory);
        }
      }
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
    return digest;
  }
  read_artifact(digest) {
    if (!/^[a-f0-9]{64}$/.test(digest)) fail("STORAGE_UNAVAILABLE", 503);
    const filename = path.join(this.artifacts, `${digest}.json`);
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192)
      fail("STORAGE_UNAVAILABLE", 503);
    const bytes = fs.readFileSync(filename);
    if (hash(bytes) !== digest) fail("STORAGE_UNAVAILABLE", 503);
    return JSON.parse(bytes.toString("utf8"));
  }
  maintain(now = Date.now()) {
    const records = this.all();
    const finished = records
      .filter((r) => is_terminal(r.state))
      .sort((a, b) => b.finished_at - a.finished_at);
    const remove = finished.filter(
      (r, i) =>
        i >= this.max_records || r.finished_at < now - this.retention_ms,
    );
    this.db.exec("BEGIN");
    try {
      const deletion = this.db.prepare("DELETE FROM jobs WHERE id=?");
      for (const job of remove) deletion.run(job.id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    const referenced = new Set(
      this.all()
        .flatMap((r) => [r.input_hash, r.result_hash].filter(Boolean))
        .map((digest) => `${digest}.json`),
    );
    for (const file of fs.readdirSync(this.artifacts, {
      withFileTypes: true,
    })) {
      if (
        file.isFile() &&
        (/^[a-f0-9]{64}\.json$/.test(file.name) ||
          /^[a-f0-9-]{36}\.tmp$/.test(file.name)) &&
        !referenced.has(file.name)
      ) {
        fs.unlinkSync(path.join(this.artifacts, file.name));
      }
    }
  }
  free_bytes() {
    const stats = fs.statfsSync(this.directory);
    return Number(stats.bavail) * Number(stats.bsize);
  }
  close() {
    this.db.close();
  }
}
