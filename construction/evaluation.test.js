import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { construction_builds } from "@fracto/sdk/testing/ConstructionBuilds.js";
import { measure_construction_build } from "@fracto/sdk/testing/ConstructionMetrics.js";
import { apply_component_commands } from "@fracto/sdk/FractoComponentTools.js";
import { run_scripted_build_evaluation } from "./evaluation.js";
import { create_local_construction_client } from "./client.js";
import { run_live_build_evaluation } from "./live_evaluation.js";
import { component_document_json } from "@fracto/sdk/FractoComponentDocument.js";
import { hash } from "../inference/contracts.js";
import { select_ready_materials } from "./planner.js";

test("bounded planner candidates preserve every requested query before alternatives", () => {
  const pages = ["grass", "shrub", "tree", "dirt"].map((query) => ({
    materials: Array.from({ length: 4 }, (_, i) => ({
      id: `${query}-${i}`,
      placement_ready: true,
    })),
  }));
  pages[0].materials.unshift({ id: "unknown", placement_ready: false });
  const selected = select_ready_materials(pages);
  assert.equal(selected.length, 8);
  assert.deepEqual(
    selected.slice(0, 4).map((item) => item.id),
    ["grass-0", "shrub-0", "tree-0", "dirt-0"],
  );
  assert.equal(
    select_ready_materials([
      { materials: pages[0].materials },
      { materials: pages[0].materials },
    ]).length,
    4,
  );
});

test("wooded-path mode keeps the baseline gate, requests the named surface and independently grades the full build", async () => {
  const { builds, materials } = construction_builds(randomUUID);
  const briefs = [];
  const report = await run_live_build_evaluation({
    wooded_path_only: true,
    wooded_surface: { id: "dirt", name: "dry_dirt" },
    audit: ["dirt", "grass", "shrub", "tree"].map((query) => ({
      query,
      ready: 1,
      materials: [{ id: query }],
    })),
    catalog: {
      resolve: async (ref) =>
        Object.values(materials).find((item) => item.material.id === ref.id),
    },
    plan: async (body) => {
      briefs.push(body.brief);
      const build = builds.find(
        (item) =>
          item.id === (briefs.length === 1 ? "plain-floor" : "wooded-path"),
      );
      const commands = build.commands;
      const preview = apply_component_commands(
        body.document,
        commands,
        materials,
      );
      return {
        applied: false,
        base: { document_hash: hash(component_document_json(body.document)) },
        commands,
        preview: { document_hash: hash(component_document_json(preview)) },
      };
    },
  });
  assert.deepEqual(
    report.cases.map((item) => item.case),
    ["plain-floor", "wooded-path"],
  );
  assert.ok(report.cases.every((item) => item.passed));
  assert.equal(report.cases[1].instances, 50);
  assert.equal(report.cases[1].checks.requested_surface, true);
  assert.match(briefs[1], /dry_dirt/);
});

test("eight representative build fixtures and six fault cases meet their independent evaluation expectations", async () => {
  const report = await run_scripted_build_evaluation();
  assert.equal(report.cases.length, 8);
  assert.equal(new Set(report.cases.map((item) => item.case)).size, 8);
  for (const result of report.cases)
    assert.equal(result.harness_pass, true, JSON.stringify(result));
  assert.equal(report.cases.filter((item) => item.passed).length, 7);
  assert.equal(report.faults.length, 6);
  for (const result of report.faults)
    assert.equal(result.passed, true, JSON.stringify(result));
  assert.equal(report.memory_comparison.live_benefit, "not_measured");
  assert.equal(report.memory_comparison.without_guidance, 1);
  assert.equal(report.memory_comparison.with_guidance, 0);
});
test("semantic grading detects blocked paths and wrong counts even when tool batches are structurally valid", () => {
  const { materials, builds } = construction_builds(randomUUID),
    build = builds.find((item) => item.id === "garden-placements");
  const commands = structuredClone(build.commands);
  commands[1].object.position = [0, 0, 0];
  const blocked = measure_construction_build(
    apply_component_commands(build.base, commands, materials),
    materials,
    build.expected,
  );
  assert.equal(blocked.passed, false);
  assert.equal(blocked.exclusion_intersections, 1);
  assert.equal(
    measure_construction_build(
      apply_component_commands(build.base, commands.slice(0, -1), materials),
      materials,
      build.expected,
    ).checks.counts,
    false,
  );
});
test("local evaluation caller uses fixed machine transport and preserves bounded engine error codes", async () => {
  const token = "a".repeat(64),
    { builds } = construction_builds(randomUUID);
  let calls = 0;
  const client = await create_local_construction_client({
    environment: { FRACTO_AI_PORT: "32123", FRACTO_AI_INFERENCE_TOKEN: token },
    request: async (url, options) => {
      calls++;
      assert.equal(url, "http://127.0.0.1:32123/inference/construction/plan");
      assert.equal(options.headers["X-Fracto-AI-Token"], token);
      assert.equal(options.headers.cookie, undefined);
      assert.equal(options.redirect, "manual");
      return new Response(JSON.stringify({ error: "DEADLINE_EXCEEDED" }), {
        status: 504,
      });
    },
  });
  await assert.rejects(
    client({
      contract_version: 1,
      brief: builds[0].brief,
      document: builds[0].base,
    }),
    (error) => error.message === "DEADLINE_EXCEEDED" && error.status === 504,
  );
  assert.equal(calls, 1);
});
test("live evaluation stops on a failed baseline without reporting skipped scenes as passes", async () => {
  let calls = 0;
  const report = await run_live_build_evaluation({
    plan: async () => {
      calls++;
      throw new Error("DEADLINE_EXCEEDED");
    },
    catalog: {},
    audit: [],
  });
  assert.equal(calls, 1);
  assert.equal(report.cases[0].outcome, "fail");
  assert.ok(report.cases.slice(1).every((item) => item.outcome === "not_run"));
  assert.equal(report.memory_benefit, "not_measured");
});
test("plain-floor-only evaluation runs no additional cases and allowlists phase timings", async () => {
  let calls = 0;
  const report = await run_live_build_evaluation({
    plain_floor_only: true,
    catalog: {},
    audit: [],
    plan: async (body) => {
      calls++;
      const commands = [
          {
            type: "set-floor",
            floor: {
              asset: null,
              size: [4, 12],
              texture_repeat: [1, 1],
              texture_file: null,
            },
          },
        ],
        document = apply_component_commands(body.document, commands, {});
      return {
        applied: false,
        base: { document_hash: hash(component_document_json(body.document)) },
        commands,
        preview: { document_hash: hash(component_document_json(document)) },
        timings_ms: {
          retrieval: { elapsed_ms: 10, load_ms: 2, private: "excluded" },
          construction: { elapsed_ms: 20 },
        },
      };
    },
  });
  assert.equal(calls, 1);
  assert.equal(report.cases.length, 1);
  assert.equal(report.cases[0].outcome, "pass");
  assert.equal(report.cases[0].planner_timings_ms.retrieval.elapsed_ms, 10);
  assert.ok(!JSON.stringify(report).includes("private"));
});
test("live runner assesses floor refinement and memory separately from unavailable catalog builds", async () => {
  const report = await run_live_build_evaluation({
    catalog: {},
    audit: [],
    plan: async (body) => {
      const remove = body.brief.startsWith("Remove"),
        width =
          body.guidance?.length && !body.brief.includes("exactly") ? 6 : 4;
      const commands = [
        {
          type: "set-floor",
          floor: remove
            ? null
            : {
                asset: null,
                size: [width, 12],
                texture_repeat: [1, 1],
                texture_file: null,
              },
        },
      ];
      const document = apply_component_commands(body.document, commands, {});
      return {
        applied: false,
        base: { document_hash: hash(component_document_json(body.document)) },
        commands,
        preview: { document_hash: hash(component_document_json(document)) },
      };
    },
  });
  assert.equal(
    report.cases.find((item) => item.case === "floor-refinement").outcome,
    "pass",
  );
  assert.equal(
    report.cases.find((item) => item.case === "wooded-path").outcome,
    "not_run",
  );
  assert.equal(
    report.cases.find((item) => item.case === "memory-with-guidance").outcome,
    "pass",
  );
  assert.equal(
    report.cases.find((item) => item.case === "current-direction-override")
      .outcome,
    "pass",
  );
  assert.equal(report.memory_benefit.without_guidance, 1);
  assert.equal(report.memory_benefit.with_guidance, 0);
});
