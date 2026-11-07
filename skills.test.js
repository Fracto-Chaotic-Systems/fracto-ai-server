import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { SkillRegistry } from "./skills/storage.js";
import { infrastructure_definition } from "./skills/builtin.js";
import { evaluate_release } from "./skills/evaluate.js";
import { executor_digest, run_active } from "./skills/executor.js";
import { create_skill_runtime } from "./skills/runtime.js";
import { canonical, hash } from "./skills/contracts.js";
import { KnowledgeStore } from "./knowledge/storage.js";
import { create_app } from "./app.js";

const id = "infrastructure-reference";
const definition = (version = "1.0.0") => ({
  ...structuredClone(infrastructure_definition),
  version,
});
const fixture = (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fracto-skills-"));
  const stores = [];
  const open = (options = {}) => {
    const registry = new SkillRegistry(
      path.join(directory, "registry"),
      options,
    );
    stores.push(registry);
    return registry;
  };
  const registry = open();
  const knowledge = new KnowledgeStore(path.join(directory, "knowledge"));
  knowledge.put(
    "terrain",
    "v1",
    "Terrain mesh storage belongs to the tiles service.",
  );
  const reader = new KnowledgeStore(knowledge.directory, { read_only: true });
  t.after(() => {
    reader.close();
    knowledge.close();
    stores.forEach((store) => store.close());
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, registry, reader, knowledge, open };
};

test("skill publication is immutable, canonical, bounded and rejects executable or escalated definitions", (t) => {
  const { registry } = fixture(t);
  const original = registry.publish(definition());
  const reordered = Object.fromEntries(Object.entries(definition()).reverse());
  assert.equal(registry.publish(reordered).replayed, true);
  assert.equal(registry.get(id, "1.0.0").digest, original.digest);
  const changed = definition();
  changed.description = "Different procedure release";
  assert.throws(() => registry.publish(changed), /SKILL_VERSION_CONFLICT/);
  for (const mutation of [
    (d) => (d.executor = "shell"),
    (d) => (d.permissions = ["data:write"]),
    (d) => (d.entrypoint = "unsafe.js"),
    (d) => (d.input_schema = { type: "object" }),
    (d) => (d.version = "latest"),
    (d) => (d.description = "x".repeat(32769)),
  ]) {
    const invalid = definition("2.0.0");
    mutation(invalid);
    assert.throws(() => registry.publish(invalid));
  }
  assert.equal(registry.status().versions, 1);
  assert.equal(registry.list().items[0].active, null);
});

test("activation requires passing real evaluations bound to current code and immutable definition", (t) => {
  const { registry } = fixture(t);
  registry.publish(definition());
  assert.throws(
    () => registry.select(id, "1.0.0", null, executor_digest()),
    /SKILL_NOT_EVALUATED/,
  );
  const receipt = evaluate_release(registry, id, "1.0.0");
  assert.equal(receipt.passed, receipt.total);
  assert.equal(receipt.executor_digest, executor_digest());
  registry.select(id, "1.0.0", null, executor_digest());
  assert.equal(registry.resolve(id, executor_digest()).version, "1.0.0");
  assert.throws(
    () => registry.resolve(id, "0".repeat(64)),
    /SKILL_NOT_EVALUATED/,
  );
  registry.db
    .prepare("UPDATE evaluations SET executor_digest=?")
    .run("0".repeat(64));
  assert.throws(
    () => registry.resolve(id, executor_digest()),
    /SKILL_NOT_EVALUATED/,
  );
  evaluate_release(registry, id, "1.0.0");
  assert.equal(registry.resolve(id, executor_digest()).version, "1.0.0");
});

test("failed candidate evaluations never activate and do not touch live knowledge", (t) => {
  const { registry, knowledge } = fixture(t);
  const candidate = definition();
  candidate.evaluations[1] = {
    input: { question: "unicorns" },
    state: "evidence_found",
    required_sources: ["fixture-terrain"],
  };
  registry.publish(candidate);
  const receipt = evaluate_release(registry, id, "1.0.0");
  assert.ok(receipt.passed < receipt.total);
  assert.throws(
    () => registry.select(id, "1.0.0", null, executor_digest()),
    /SKILL_NOT_EVALUATED/,
  );
  assert.equal(knowledge.status().revisions, 1);
  assert.equal(
    knowledge.get("terrain").text,
    "Terrain mesh storage belongs to the tiles service.",
  );
});

test("selection races fail explicitly, rollback retains history and disable survives reopen", (t) => {
  const { registry, open } = fixture(t);
  registry.publish(definition());
  registry.publish(definition("2.0.0"));
  evaluate_release(registry, id, "1.0.0");
  evaluate_release(registry, id, "2.0.0");
  const second = open();
  registry.select(id, "1.0.0", null, executor_digest());
  assert.throws(
    () => second.select(id, "2.0.0", null, executor_digest()),
    /ACTIVE_SKILL_CONFLICT/,
  );
  second.select(id, "2.0.0", "1.0.0", executor_digest());
  registry.select(id, "1.0.0", "2.0.0", executor_digest());
  registry.select(id, null, "1.0.0", executor_digest());
  assert.equal(registry.history().length, 4);
  registry.close();
  assert.throws(
    () => open({ read_only: true }).resolve(id, executor_digest()),
    /SKILL_DISABLED/,
  );
});

test("startup bootstraps once, preserves explicit disable and does not automatically select new candidates", (t) => {
  const { directory } = fixture(t);
  const environment = {
    FRACTO_AI_SKILL_DIR: path.join(directory, "bootstrapped"),
  };
  const first = create_skill_runtime(environment);
  assert.ok(first);
  assert.equal(first.resolve(id, executor_digest()).version, "1.0.0");
  const time = first.get(id, "1.0.0").evaluation.evaluated_at;
  first.publish(definition("2.0.0"));
  first.select(id, null, "1.0.0", executor_digest());
  first.close();
  const second = create_skill_runtime(environment);
  assert.ok(second);
  assert.equal(second.get(id, "1.0.0").evaluation.evaluated_at, time);
  assert.throws(() => second.resolve(id, executor_digest()), /SKILL_DISABLED/);
  assert.equal(second.status().versions, 4);
  second.close();
});

test("active dispatch validates input and returns pinned provenance through read-only access", (t) => {
  const { registry, reader, knowledge, open } = fixture(t);
  registry.publish(definition());
  evaluate_release(registry, id, "1.0.0");
  registry.select(id, "1.0.0", null, executor_digest());
  const readRegistry = open({ read_only: true });
  assert.throws(
    () => readRegistry.publish(definition("2.0.0")),
    /REGISTRY_READ_ONLY/,
  );
  assert.throws(
    () =>
      run_active(
        readRegistry,
        id,
        { question: "terrain", shell: "unsafe" },
        reader,
      ),
    /INVALID_SKILL_INPUT/,
  );
  assert.throws(
    () => run_active(readRegistry, id, { question: "terrain" }, knowledge),
    /READ_ONLY_REQUIRED/,
  );
  const report = run_active(
    readRegistry,
    id,
    { question: "terrain mesh storage" },
    reader,
  );
  assert.equal(report.registry.version, "1.0.0");
  assert.equal(
    report.registry.definition_digest,
    registry.get(id, "1.0.0").digest,
  );
  assert.equal(report.findings[0].source, "terrain");
  assert.equal(knowledge.status().revisions, 1);
  registry.db.prepare("UPDATE releases SET definition=?").run("{}");
  assert.throws(
    () => run_active(readRegistry, id, { question: "terrain" }, reader),
    /CORRUPT_SKILL/,
  );
});

test("registry handles capacity/disk/schema failures without resetting retained releases", (t) => {
  const { registry, open } = fixture(t);
  registry.publish(definition());
  registry.free_disk = () => 0;
  assert.throws(() => registry.publish(definition("2.0.0")), /DISK_PRESSURE/);
  assert.equal(registry.get(id, "1.0.0").version, "1.0.0");
  registry.free_disk = () => 1024 ** 4;
  const insert = registry.db.prepare("INSERT INTO releases VALUES(?,?,?,?,?)");
  registry.db.exec("BEGIN IMMEDIATE");
  for (let n = 1; n <= 999; n++) {
    const release = definition(`0.0.${n}`),
      text = canonical(release);
    insert.run(id, release.version, hash(text), text, Date.now());
  }
  registry.db.exec("COMMIT");
  assert.equal(registry.status().versions, 1000);
  assert.equal(registry.versions(id).items.length, 20);
  assert.ok(registry.versions(id).next_cursor);
  assert.throws(() => registry.publish(definition("2.0.0")), /SKILL_CAPACITY/);
  registry.db.exec("PRAGMA user_version=99");
  registry.close();
  assert.throws(() => open(), /UNKNOWN_SKILL_SCHEMA/);
});

test("local registry CLI dispatches the active release and emits fixed errors without private paths", (t) => {
  const { directory, registry } = fixture(t);
  registry.publish(definition());
  evaluate_release(registry, id, "1.0.0");
  registry.select(id, "1.0.0", null, executor_digest());
  const file = path.join(directory, "input.json");
  fs.writeFileSync(file, JSON.stringify({ question: "terrain mesh" }));
  const options = {
    cwd: import.meta.dirname,
    encoding: "utf8",
    env: {
      ...process.env,
      FRACTO_AI_SKILL_DIR: registry.directory,
      FRACTO_AI_KNOWLEDGE_DIR: path.join(directory, "knowledge"),
    },
  };
  const success = spawnSync(
    process.execPath,
    ["skills/cli.js", "run", id, file],
    options,
  );
  assert.equal(success.status, 0, success.stderr);
  assert.equal(JSON.parse(success.stdout).registry.version, "1.0.0");
  registry.select(id, null, "1.0.0", executor_digest());
  const failure = spawnSync(
    process.execPath,
    ["skills/cli.js", "run", id, file],
    options,
  );
  assert.equal(failure.status, 1);
  assert.match(failure.stderr, /SKILL_DISABLED/);
  assert.equal(failure.stderr.includes(directory), false);
});

test("public registry status exposes only aggregates and failure preserves foundation readiness", async (t) => {
  let broken = false;
  const server = create_app({
    skill_status: () => {
      if (broken) throw new Error("private path");
      return {
        state: "ready",
        skills: 1,
        active: 1,
        versions: 2,
        version_limit: 1000,
        definition: "private instructions",
        owner: "private identity",
      };
    },
  }).listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/skills/status`),
    body = await response.json();
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(Object.keys(body).length, 6);
  assert.equal(JSON.stringify(body).includes("private"), false);
  broken = true;
  assert.deepEqual(await fetch(`${base}/skills/status`).then((r) => r.json()), {
    contract_version: 1,
    state: "unavailable",
  });
  assert.equal((await fetch(`${base}/readyz`)).status, 200);
  assert.equal(
    (await fetch(`${base}/skills/run`, { method: "POST" })).status,
    404,
  );
});
