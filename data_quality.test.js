import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { scan_environment_assets } from "./data_quality/scan.js";
import {
  clean_fixture,
  duplicate_fixture,
  data_quality_definition,
} from "./data_quality/builtin.js";
import { output_validator } from "./data_quality/contracts.js";
import { SkillRegistry } from "./skills/storage.js";
import { create_skill_runtime } from "./skills/runtime.js";
import { evaluate_release } from "./skills/evaluate.js";
import { run_active, executor_digest } from "./skills/executor.js";
import { normalize_definition } from "./skills/contracts.js";

const freeze = (value) => {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const fixture = (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fracto-quality-"));
  const registry = new SkillRegistry(path.join(directory, "skills"));
  t.after(() => {
    registry.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, registry };
};

test("clean and empty snapshots have stable provenance without mutating inputs", () => {
  const input = freeze(clean_fixture()),
    before = JSON.stringify(input);
  const report = scan_environment_assets(input);
  assert.equal(report.state, "clean");
  assert.equal(report.findings_total, 0);
  assert.equal(report.proposals_total, 0);
  assert.equal(report.apply_supported, false);
  assert.equal(report.proposals_only, true);
  assert.match(report.snapshot_digest, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(input), before);
  assert.equal(output_validator(report), true);
  assert.deepEqual(scan_environment_assets(input), report);
  assert.equal(
    scan_environment_assets({
      environments: input.environments,
      assets: input.assets,
      dataset_revision: 1,
      contract_version: 1,
    }).snapshot_digest,
    report.snapshot_digest,
  );
  const empty = scan_environment_assets({
    contract_version: 1,
    dataset_revision: 1,
    assets: [],
    environments: [],
  });
  assert.equal(empty.state, "clean");
  assert.equal(empty.summary.references, 0);
});

test("missing and ambiguous references, duplicate identifiers and repeated references never become guessed corrections", () => {
  const input = {
    contract_version: 1,
    dataset_revision: 3,
    assets: [
      { asset_id: 1, content_digest: "a".repeat(64) },
      { asset_id: 1, content_digest: "b".repeat(64) },
      { asset_id: 2, content_digest: "c".repeat(64) },
    ],
    environments: [
      { environment_id: 10, revision: 1, asset_ids: [1, 1, 99, 99] },
      { environment_id: 10, revision: 2, asset_ids: [2, 2] },
    ],
  };
  const report = scan_environment_assets(freeze(input));
  assert.equal(report.summary.duplicate_asset_ids, 1);
  assert.equal(report.summary.duplicate_environment_ids, 1);
  assert.equal(report.summary.missing_asset_references, 2);
  assert.equal(report.summary.ambiguous_asset_references, 2);
  assert.equal(report.summary.duplicate_asset_references, 3);
  assert.equal(report.proposals_total, 0);
  assert.ok(
    report.findings.some(
      (f) =>
        f.code === "missing_asset_reference" &&
        f.asset_id === 99 &&
        f.count === 2,
    ),
  );
  assert.ok(
    report.findings.some(
      (f) => f.code === "ambiguous_asset_reference" && f.asset_id === 1,
    ),
  );
  assert.equal(output_validator(report), true);
});

test("safe deduplication proposals preserve order, old values and source revisions with deterministic snapshot binding", () => {
  const input = clean_fixture();
  input.dataset_revision = 7;
  input.assets.push({ asset_id: 2, content_digest: "b".repeat(64) });
  input.environments[0] = {
    environment_id: 25,
    revision: 9,
    asset_ids: [2, 1, 2, 1],
  };
  const report = scan_environment_assets(freeze(input)),
    proposal = report.proposals[0];
  assert.equal(proposal.kind, "deduplicate_asset_references");
  assert.equal(proposal.environment_id, 25);
  assert.equal(proposal.expected_revision, 9);
  assert.deepEqual(proposal.expected_asset_ids, [2, 1, 2, 1]);
  assert.deepEqual(proposal.proposed_asset_ids, [2, 1]);
  assert.match(proposal.proposal_digest, /^[a-f0-9]{64}$/);
  assert.equal(
    scan_environment_assets(input).proposals[0].proposal_digest,
    proposal.proposal_digest,
  );
  const changed = structuredClone(input);
  changed.dataset_revision = 8;
  assert.notEqual(
    scan_environment_assets(changed).proposals[0].proposal_digest,
    proposal.proposal_digest,
  );
  assert.equal(output_validator(report), true);
});

test("unused assets and identical content are bounded patterns without merge or deletion proposals", () => {
  const input = clean_fixture();
  input.assets.push(
    { asset_id: 2, content_digest: "a".repeat(64) },
    { asset_id: 3, content_digest: "b".repeat(64) },
  );
  const report = scan_environment_assets(input);
  assert.equal(report.summary.unused_assets, 2);
  assert.equal(report.summary.identical_content_groups, 1);
  assert.equal(report.proposals_total, 0);
  const group = report.findings.find(
    (f) => f.code === "identical_asset_content",
  );
  assert.equal(group.count, 2);
  assert.deepEqual(group.sample_asset_ids, [1, 2]);
});

test("large admitted snapshots are fully counted despite truncated diagnostic and proposal details", () => {
  const input = {
    contract_version: 1,
    dataset_revision: 1,
    assets: Array.from({ length: 20000 }, (_, n) => ({
      asset_id: n + 1,
      content_digest: (n + 1).toString(16).padStart(64, "0"),
    })),
    environments: Array.from({ length: 10000 }, (_, n) => ({
      environment_id: n + 1,
      revision: 1,
      asset_ids: [n + 1, n + 1],
    })),
  };
  const report = scan_environment_assets(input);
  assert.equal(report.summary.references, 20000);
  assert.equal(report.summary.duplicate_asset_references, 10000);
  assert.equal(report.summary.unused_assets, 10000);
  assert.equal(report.findings_total, 20000);
  assert.equal(report.proposals_total, 10000);
  assert.equal(report.findings.length, 200);
  assert.equal(report.proposals.length, 100);
  assert.equal(report.findings_truncated, true);
  assert.equal(report.proposals_truncated, true);
  assert.equal(output_validator(report), true);
});

test("strict snapshot contracts reject malformed, identifying, oversized and excessive-reference inputs", () => {
  for (const mutate of [
    (x) => (x.assets[0].owner = "private name"),
    (x) => (x.assets[0].asset_id = -1),
    (x) => (x.assets[0].content_digest = "z".repeat(64)),
    (x) => (x.environments[0].revision = 0),
    (x) => (x.environments[0].asset_ids = Array(65).fill(1)),
    (x) => (x.assets = Array(20001).fill(x.assets[0])),
    (x) =>
      (x.environments = Array(3907).fill({
        environment_id: 1,
        revision: 1,
        asset_ids: Array(64).fill(1),
      })),
  ]) {
    const input = clean_fixture();
    mutate(input);
    assert.throws(() => scan_environment_assets(input), /INVALID_SKILL_INPUT/);
  }
  const boundary = {
    contract_version: 1,
    dataset_revision: 1,
    assets: Array.from({ length: 20000 }, (_, n) => ({
      asset_id: n + 1,
      content_digest: "a".repeat(64),
    })),
    environments: Array.from({ length: 10000 }, (_, n) => ({
      environment_id: n + 1,
      revision: 1,
      asset_ids: Array(25).fill(2147483647),
    })),
  };
  // This is within the aggregate reference limit; the field-count caps still bound memory.
  const report = scan_environment_assets(boundary);
  assert.equal(report.summary.references, 250000);
  assert.equal(report.summary.missing_asset_references, 250000);
});

test("data-quality release passes isolated evaluations and dispatches without a knowledge store", (t) => {
  const { registry } = fixture(t);
  registry.publish(data_quality_definition);
  assert.throws(
    () =>
      registry.select(
        "environment-asset-quality",
        "1.0.0",
        null,
        executor_digest(),
      ),
    /SKILL_NOT_EVALUATED/,
  );
  const receipt = evaluate_release(
    registry,
    "environment-asset-quality",
    "1.0.0",
  );
  assert.equal(receipt.passed, receipt.total);
  registry.select(
    "environment-asset-quality",
    "1.0.0",
    null,
    executor_digest(),
  );
  const report = run_active(
    registry,
    "environment-asset-quality",
    duplicate_fixture(),
  );
  assert.equal(report.registry.version, "1.0.0");
  assert.equal(report.proposals_total, 1);
  registry.select(
    "environment-asset-quality",
    null,
    "1.0.0",
    executor_digest(),
  );
  assert.throws(
    () => run_active(registry, "environment-asset-quality", clean_fixture()),
    /SKILL_DISABLED/,
  );
});

test("registry profiles cannot mix permissions or schemas; failed quality candidates cannot activate", (t) => {
  const { registry } = fixture(t);
  for (const mutate of [
    (x) => (x.permissions = ["data:write"]),
    (x) => (x.permissions = ["knowledge:read"]),
    (x) => (x.skill_id = "infrastructure-reference"),
    (x) => (x.input_schema = { type: "object" }),
  ]) {
    const candidate = structuredClone(data_quality_definition);
    mutate(candidate);
    assert.throws(() => normalize_definition(candidate));
  }
  const candidate = structuredClone(data_quality_definition);
  candidate.version = "2.0.0";
  candidate.evaluations[1].state = "clean";
  registry.publish(candidate);
  const receipt = evaluate_release(
    registry,
    "environment-asset-quality",
    "2.0.0",
  );
  assert.ok(receipt.passed < receipt.total);
  assert.throws(
    () =>
      registry.select(
        "environment-asset-quality",
        "2.0.0",
        null,
        executor_digest(),
      ),
    /SKILL_NOT_EVALUATED/,
  );
});

test("startup and local CLI support snapshots larger than definition limits without opening knowledge or exposing private data", (t) => {
  const { registry, directory } = fixture(t);
  const environment = { FRACTO_AI_SKILL_DIR: registry.directory };
  const runtime = create_skill_runtime(environment);
  assert.ok(runtime);
  assert.equal(runtime.status().skills, 3);
  runtime.close();
  const input = duplicate_fixture();
  input.environments = Array.from({ length: 1000 }, (_, n) => ({
    environment_id: n + 1,
    revision: 1,
    asset_ids: [1, 1],
  }));
  const file = path.join(directory, "snapshot.json");
  fs.writeFileSync(file, JSON.stringify(input));
  assert.ok(fs.statSync(file).size > 32768);
  const options = {
    cwd: import.meta.dirname,
    encoding: "utf8",
    maxBuffer: 2 * 1024 ** 2,
    env: {
      ...process.env,
      ...environment,
      FRACTO_AI_KNOWLEDGE_DIR: path.join(directory, "does-not-exist"),
    },
  };
  // Windows PowerShell commonly writes UTF-8 with a BOM; both CLIs accept it.
  fs.writeFileSync(file, "\ufeff" + JSON.stringify(input));
  for (const args of [
    ["data_quality/cli.js", "scan", file],
    ["skills/cli.js", "run", "environment-asset-quality", file],
  ]) {
    const result = spawnSync(process.execPath, args, options);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).proposals_total, 1000);
  }
  const before = fs.readFileSync(file, "utf8");
  const scan = scan_environment_assets(input);
  const selected = spawnSync(
    process.execPath,
    ["data_quality/cli.js", "request", file, scan.proposals[0].proposal_digest],
    options,
  );
  assert.equal(selected.status, 0, selected.stderr);
  const request = JSON.parse(selected.stdout);
  assert.equal(
    request.proposal.proposal_digest,
    scan.proposals[0].proposal_digest,
  );
  assert.equal(request.skill.id, "environment-asset-quality");
  assert.equal(Object.hasOwn(request, "approved"), false);
  assert.equal(before, "\ufeff" + JSON.stringify(input));
  fs.writeFileSync(
    file,
    JSON.stringify({ ...clean_fixture(), owner: "private" }),
  );
  const invalid = spawnSync(
    process.execPath,
    ["data_quality/cli.js", "scan", file],
    options,
  );
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /INVALID_SKILL_INPUT/);
  assert.equal(invalid.stderr.includes("private"), false);
  const fd = fs.openSync(file, "w");
  fs.ftruncateSync(fd, 8 * 1024 ** 2 + 1);
  fs.closeSync(fd);
  const tooLarge = spawnSync(
    process.execPath,
    ["data_quality/cli.js", "scan", file],
    options,
  );
  assert.equal(tooLarge.status, 1);
  assert.match(tooLarge.stderr, /INVALID_SKILL_FILE/);
  assert.equal(tooLarge.stderr.includes(directory), false);
});
