import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { create_skill_runtime } from "../skills/runtime.js";
import { run_active } from "../skills/executor.js";
import { select_correction_request } from "../data_quality/request.js";
import { duplicate_fixture } from "../data_quality/builtin.js";
import {launch_service_fixture}from"@fracto/sdk/testing/ServiceFixture.js";
import{fileURLToPath}from"node:url";

test("AI read-only proposal passes independent owner preview/approval/apply/rollback without live tables", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "fracto-correction-integration-"),
  );
  const registry = create_skill_runtime({
    FRACTO_AI_SKILL_DIR: path.join(directory, "skills"),
  });
  const owner=await launch_service_fixture(fileURLToPath(new URL("../../fracto-data-server/tests/correction_fixture.mjs",import.meta.url)),{directory:path.join(directory,"owner")},t);
  t.after(async () => {
    registry?.close();
    await owner.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  assert.ok(registry);
  const input = duplicate_fixture();
  await owner.request("register",{id:"world",snapshot:input});
  const report = run_active(
    registry,
    "environment-asset-quality",
    (await owner.request("read",{id:"world"})),
  );
  assert.equal(report.apply_supported, false);
  const request = select_correction_request(
    report,
    report.proposals[0].proposal_digest,
  );
  const plan = await owner.request("preview",{id:"world",request});
  assert.equal(plan.state, "prepared");
  await assert.rejects(owner.request("apply",{digest:plan.plan_digest}), /CORRECTION_NOT_APPROVED/);
  await owner.request("approve",{digest:plan.plan_digest,revision:request.snapshot_digest});
  const applied = await owner.request("apply",{digest:plan.plan_digest});
  assert.equal(
    run_active(registry, "environment-asset-quality", (await owner.request("read",{id:"world"})))
      .state,
    "clean",
  );
  await owner.request("approve_rollback",{digest:plan.plan_digest,revision:applied.after_digest});
  await owner.request("rollback",{digest:plan.plan_digest});
  assert.deepEqual((await owner.request("read",{id:"world"})).environments[0].asset_ids, [1, 1]);
  assert.equal((await owner.request("read",{id:"world"})).dataset_revision, 3);
  assert.equal(
    registry.get("environment-asset-quality", "1.0.0").definition
      .permissions[0],
    "snapshot:read",
  );
});
