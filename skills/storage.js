import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { secure_directory } from "../peers/files.js";
import {
  canonical,
  hash,
  fail,
  label,
  version_label,
  normalize_definition,
} from "./contracts.js";

const regular = (file) => {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail("INVALID_REGISTRY_FILE");
};
export class SkillRegistry {
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
        const stat = fs.lstatSync(this.directory);
        if (!stat.isDirectory() || stat.isSymbolicLink())
          fail("INVALID_REGISTRY_FILE");
      } else secure_directory(this.directory);
      const file = path.join(this.directory, "skills.sqlite");
      for (const suffix of ["", "-journal", "-wal", "-shm"])
        if (fs.existsSync(file + suffix)) regular(file + suffix);
      if (read_only) regular(file);
      this.db = new DatabaseSync(file, { readOnly: read_only });
      this.db.exec("PRAGMA busy_timeout=2000");
      if (read_only) {
        this.db.exec("PRAGMA query_only=ON");
        if (this.db.prepare("PRAGMA user_version").get().user_version !== 1)
          fail("UNKNOWN_SKILL_SCHEMA");
        return;
      }
      if (process.platform !== "win32") fs.chmodSync(file, 0o600);
      this.db.exec(
        "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA max_page_count=16384",
      );
      this.transaction(() => {
        if (
          ![0, 1].includes(
            this.db.prepare("PRAGMA user_version").get().user_version,
          )
        )
          fail("UNKNOWN_SKILL_SCHEMA");
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS skills(id TEXT PRIMARY KEY, active TEXT, bootstrapped INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE IF NOT EXISTS releases(id TEXT NOT NULL, version TEXT NOT NULL, digest TEXT NOT NULL, definition TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(id,version));
          CREATE TABLE IF NOT EXISTS evaluations(id TEXT NOT NULL, version TEXT NOT NULL, definition_digest TEXT NOT NULL, executor_digest TEXT NOT NULL, total INTEGER NOT NULL, passed INTEGER NOT NULL, evaluated_at INTEGER NOT NULL, PRIMARY KEY(id,version));
          CREATE TABLE IF NOT EXISTS history(sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, previous TEXT, selected TEXT, definition_digest TEXT, changed_at INTEGER NOT NULL);
          PRAGMA user_version=1;
        `);
      });
    } catch (error) {
      this.close();
      throw error;
    }
  }
  transaction(operation) {
    if (this.read_only) fail("REGISTRY_READ_ONLY");
    if (this.free_disk() < 1024 ** 3) fail("DISK_PRESSURE");
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
  publish(value) {
    const definition = normalize_definition(value),
      text = canonical(definition),
      digest = hash(text);
    return this.transaction(() => {
      const old = this.db
        .prepare("SELECT digest FROM releases WHERE id=? AND version=?")
        .get(definition.skill_id, definition.version);
      if (old) {
        if (old.digest !== digest) fail("SKILL_VERSION_CONFLICT");
        return {
          ...this.get(definition.skill_id, definition.version),
          replayed: true,
        };
      }
      if (this.db.prepare("SELECT count(*) AS n FROM releases").get().n >= 1000)
        fail("SKILL_CAPACITY");
      this.db
        .prepare("INSERT INTO skills(id) VALUES(?) ON CONFLICT(id) DO NOTHING")
        .run(definition.skill_id);
      this.db
        .prepare("INSERT INTO releases VALUES(?,?,?,?,?)")
        .run(definition.skill_id, definition.version, digest, text, Date.now());
      return {
        ...this.get(definition.skill_id, definition.version),
        replayed: false,
      };
    });
  }
  get(id, version) {
    label(id);
    version_label(version);
    const row = this.db
      .prepare("SELECT * FROM releases WHERE id=? AND version=?")
      .get(id, version);
    if (!row) fail("SKILL_NOT_FOUND");
    if (
      Buffer.byteLength(row.definition) > 32768 ||
      hash(row.definition) !== row.digest
    )
      fail("CORRUPT_SKILL");
    let definition;
    try {
      definition = normalize_definition(JSON.parse(row.definition));
    } catch {
      fail("CORRUPT_SKILL");
    }
    if (definition.skill_id !== id || definition.version !== version)
      fail("CORRUPT_SKILL");
    return {
      id,
      version,
      digest: row.digest,
      created_at: row.created_at,
      definition,
      evaluation:
        this.db
          .prepare(
            "SELECT definition_digest,executor_digest,total,passed,evaluated_at FROM evaluations WHERE id=? AND version=?",
          )
          .get(id, version) ?? null,
    };
  }
  record_evaluation(id, version, fingerprint, summary) {
    if (
      !/^[a-f0-9]{64}$/.test(fingerprint) ||
      !Number.isInteger(summary.total) ||
      summary.total < 5 ||
      summary.total > 18 ||
      !Number.isInteger(summary.passed) ||
      summary.passed < 0 ||
      summary.passed > summary.total
    )
      fail("INVALID_EVALUATION");
    return this.transaction(() => {
      const release = this.get(id, version);
      this.db
        .prepare(
          "INSERT INTO evaluations VALUES(?,?,?,?,?,?,?) ON CONFLICT(id,version) DO UPDATE SET definition_digest=excluded.definition_digest,executor_digest=excluded.executor_digest,total=excluded.total,passed=excluded.passed,evaluated_at=excluded.evaluated_at",
        )
        .run(
          id,
          version,
          release.digest,
          fingerprint,
          summary.total,
          summary.passed,
          Date.now(),
        );
      return this.get(id, version).evaluation;
    });
  }
  checked(id, version, fingerprint) {
    const release = this.get(id, version),
      evaluation = release.evaluation;
    if (
      !evaluation ||
      evaluation.definition_digest !== release.digest ||
      evaluation.executor_digest !== fingerprint ||
      evaluation.total !==
        2 +
          release.definition.evaluations.length +
          release.definition.examples.length ||
      evaluation.passed !== evaluation.total
    )
      fail("SKILL_NOT_EVALUATED");
    return release;
  }
  select(id, version, expected, fingerprint, { bootstrap = false } = {}) {
    label(id);
    if (version !== null) version_label(version);
    if (expected !== null) version_label(expected);
    return this.transaction(() => {
      const current = this.db
        .prepare("SELECT * FROM skills WHERE id=?")
        .get(id);
      if (!current) fail("SKILL_NOT_FOUND");
      if (bootstrap && current.bootstrapped)
        return { active: current.active, changed: false };
      if (current.active !== expected) fail("ACTIVE_SKILL_CONFLICT");
      const release =
        version === null ? null : this.checked(id, version, fingerprint);
      this.db
        .prepare("UPDATE skills SET active=?,bootstrapped=1 WHERE id=?")
        .run(version, id);
      if (current.active !== version) {
        this.db
          .prepare(
            "INSERT INTO history(id,previous,selected,definition_digest,changed_at) VALUES(?,?,?,?,?)",
          )
          .run(
            id,
            current.active,
            version,
            release?.digest ?? null,
            Date.now(),
          );
        this.db.exec(
          "DELETE FROM history WHERE sequence NOT IN (SELECT sequence FROM history ORDER BY sequence DESC LIMIT 1000)",
        );
      }
      return { active: version, changed: current.active !== version };
    });
  }
  resolve(id, fingerprint) {
    label(id);
    const row = this.db.prepare("SELECT active FROM skills WHERE id=?").get(id);
    if (!row?.active) fail("SKILL_DISABLED");
    return this.checked(id, row.active, fingerprint);
  }
  list(after = "") {
    if (after) label(after);
    const rows = this.db
      .prepare(
        "SELECT id,active,bootstrapped FROM skills WHERE id>? ORDER BY id LIMIT 21",
      )
      .all(after);
    return {
      items: rows.slice(0, 20),
      next_cursor: rows.length > 20 ? rows[19].id : null,
    };
  }
  versions(id, after = "") {
    label(id);
    if (after) version_label(after);
    const rows = this.db
      .prepare(
        "SELECT id,version,digest,created_at FROM releases WHERE id=? AND version>? ORDER BY version LIMIT 21",
      )
      .all(id, after);
    return {
      items: rows.slice(0, 20),
      next_cursor: rows.length > 20 ? rows[19].version : null,
    };
  }
  history() {
    return this.db
      .prepare("SELECT * FROM history ORDER BY sequence DESC LIMIT 20")
      .all();
  }
  status() {
    return {
      contract_version: 1,
      state: "ready",
      skills: this.db.prepare("SELECT count(*) AS n FROM skills").get().n,
      active: this.db
        .prepare("SELECT count(*) AS n FROM skills WHERE active IS NOT NULL")
        .get().n,
      versions: this.db.prepare("SELECT count(*) AS n FROM releases").get().n,
      version_limit: 1000,
    };
  }
  close() {
    this.db?.close();
    this.db = null;
  }
}
