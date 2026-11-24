import { randomUUID } from "node:crypto";
import { construction_builds } from "@fracto/sdk/testing/ConstructionBuilds.js";
import { measure_construction_build } from "@fracto/sdk/testing/ConstructionMetrics.js";
import {
  apply_component_commands,
  component_reference_key,
} from "@fracto/sdk/FractoComponentTools.js";
import {
  component_document_json,
  create_component_document,
} from "@fracto/sdk/FractoComponentDocument.js";
import { hash } from "../inference/contracts.js";

export async function run_live_build_evaluation({
  plan,
  catalog,
  audit,
  on_case = () => {},
  plain_floor_only = false,
  wooded_path_only = false,
  wooded_surface = null,
}) {
  const { builds } = construction_builds(randomUUID),
    results = [];
  const evaluate = async (id, body, expected) => {
    on_case(id);
    const start = performance.now();
    try {
      const proposal = await plan(body);
      if (
        proposal.applied !== false ||
        proposal.base.document_hash !==
          hash(component_document_json(body.document))
      )
        throw new Error("EVALUATION_PROPOSAL_BINDING");
      const refs = proposal.commands.flatMap((command) =>
          [
            command.floor?.asset,
            command.object?.asset,
            command.rule?.asset,
          ].filter(Boolean),
        ),
        materials = {};
      for (const ref of refs)
        materials[component_reference_key(ref)] = await catalog.resolve(
          ref,
          AbortSignal.timeout(20000),
        );
      const document = proposal.commands.length
        ? apply_component_commands(body.document, proposal.commands, materials)
        : body.document;
      if (
        hash(component_document_json(document)) !==
        proposal.preview.document_hash
      )
        throw new Error("EVALUATION_PREVIEW_BINDING");
      const normalized = structuredClone(document),
        normalized_materials = {};
      for (const entry of Object.values(materials)) {
        const roles = audit
          .filter((page) =>
            page.materials?.some((item) => item.id === entry.material.id),
          )
          .map((page) => page.query);
        if (roles.length !== 1)
          throw new Error("EVALUATION_MATERIAL_ROLE_AMBIGUOUS");
        normalized_materials[
          component_reference_key({
            id: roles[0],
            revision: entry.material.revision,
          })
        ] = entry;
        for (const ref of [
          normalized.floor?.asset,
          ...normalized.objects.map((item) => item.asset),
          ...normalized.scatters.map((item) => item.asset),
        ].filter(Boolean))
          if (ref.id === entry.material.id) ref.id = roles[0];
      }
      const measured = measure_construction_build(
        normalized,
        normalized_materials,
        expected,
      );
      if (id === "wooded-path" && wooded_surface) {
        measured.checks.requested_surface =
          document.floor?.asset?.id === wooded_surface.id;
        measured.passed = Object.values(measured.checks).every(Boolean);
        measured.correction_proxy = Object.values(measured.checks).filter(
          (value) => !value,
        ).length;
      }
      results.push({
        case: id,
        outcome: measured.passed ? "pass" : "fail",
        elapsed_ms: Math.round(performance.now() - start),
        proposal_status: proposal.status || null,
        information_needed: (proposal.information_needed || []).map(
          ({ query, reason, total_matches }) => ({
            query,
            reason,
            total_matches,
          }),
        ),
        ...(wooded_path_only && id === "wooded-path"
          ? { preview_document: document }
          : {}),
        planner_timings_ms: Object.fromEntries(
          ["retrieval", "construction"].map((phase) => [
            phase,
            Object.fromEntries(
              [
                "elapsed_ms",
                "load_ms",
                "input_ms",
                "output_ms",
                "input_tokens",
                "output_tokens",
              ].map((key) => [
                key,
                Number.isFinite(proposal.timings_ms?.[phase]?.[key])
                  ? proposal.timings_ms[phase][key]
                  : null,
              ]),
            ),
          ]),
        ),
        ...measured,
      });
      return { document, passed: measured.passed };
    } catch (error) {
      results.push({
        case: id,
        outcome: "fail",
        elapsed_ms: Math.round(performance.now() - start),
        error: /^[A-Z_]+$/.test(error.message)
          ? error.message
          : "EVALUATION_TRANSPORT_OR_PLAN_INVALID",
      });
      return null;
    }
  };
  const floor = builds.find((build) => build.id === "plain-floor"),
    body = (brief) => ({
      contract_version: 1,
      brief,
      document: create_component_document(
        randomUUID(),
        "Live construction evaluation",
      ),
    });
  const baseline = await evaluate(
    "plain-floor",
    body(floor.brief),
    floor.expected,
  );
  if (plain_floor_only)
    return { cases: results, memory_benefit: "not_measured" };
  if (!baseline?.passed) {
    for (const id of wooded_path_only
      ? ["wooded-path"]
      : [
          "wooded-path",
          "cross-path-meadow",
          "garden-placements",
          "floor-refinement",
          "memory-without-guidance",
          "memory-with-guidance",
          "current-direction-override",
        ])
      results.push({
        case: id,
        outcome: "not_run",
        reason: "baseline_gate_failed",
      });
    return { cases: results, memory_benefit: "not_measured" };
  }
  for (const id of wooded_path_only
    ? ["wooded-path"]
    : ["wooded-path", "cross-path-meadow", "garden-placements"]) {
    const build = builds.find((item) => item.id === id),
      required = Object.keys(build.expected.counts).concat("dirt");
    if (
      required.some(
        (query) => !audit.find((page) => page.query === query)?.ready,
      )
    )
      results.push({
        case: id,
        outcome: "not_run",
        reason: "catalog_calibration_required",
      });
    else
      await evaluate(
        id,
        body(
          build.brief +
            (wooded_surface
              ? ` Use the ${wooded_surface.name} material as the ground texture.`
              : ""),
        ),
        build.expected,
      );
  }
  if (wooded_path_only)
    return { cases: results, memory_benefit: "not_measured" };
  await evaluate(
    "floor-refinement",
    {
      ...body("Remove only the plain floor. No materials or new objects."),
      document: baseline.document,
    },
    { floor_size: undefined, counts: {}, floor_material: null },
  );
  const brief =
      "Propose a plain neutral floor 12 meters deep with a reasonable width. No textures, materials or objects.",
    guidance = [
      {
        kind: "preference",
        instructions:
          "When no width is requested, prefer plain floors 6 meters wide.",
      },
    ];
  const without = await evaluate("memory-without-guidance", body(brief), {
    floor_size: [6, 12],
    floor_material: null,
    counts: {},
  });
  results.at(-1).comparison_only = true;
  const with_guidance = await evaluate(
    "memory-with-guidance",
    { ...body(brief), guidance },
    { floor_size: [6, 12], floor_material: null, counts: {} },
  );
  await evaluate(
    "current-direction-override",
    { ...body(floor.brief), guidance },
    floor.expected,
  );
  return {
    cases: results,
    memory_benefit:
      without && with_guidance
        ? {
            metric: "failed_scene_criteria_proxy_not_human_corrections",
            without_guidance: results.find(
              (item) => item.case === "memory-without-guidance",
            ).correction_proxy,
            with_guidance: results.find(
              (item) => item.case === "memory-with-guidance",
            ).correction_proxy,
            samples_per_condition: 1,
          }
        : "not_measured",
  };
}
