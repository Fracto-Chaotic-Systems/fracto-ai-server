import { randomUUID } from "node:crypto";
import { construction_builds } from "@fracto/sdk/testing/ConstructionBuilds.js";
import {
  measure_construction_build,
  construction_instances,
} from "@fracto/sdk/testing/ConstructionMetrics.js";
import {
  component_document_json,
  create_component_history,
  edit_component_history,
  undo_component_history,
  redo_component_history,
} from "@fracto/sdk/FractoComponentDocument.js";
import {
  apply_component_commands,
  component_reference_key,
} from "@fracto/sdk/FractoComponentTools.js";
import { create_construction_planner } from "./planner.js";
import { generation_request } from "../engines/contracts.js";
import { hash, fail } from "../inference/contracts.js";
import { EngineError } from "../engines/errors.js";
import {
  empty_material_construction,
  material_view,
} from "@fracto/sdk/FractoMaterialMetadata.js";

export function evaluate_proposal(build, proposal, materials) {
  const before = component_document_json(build.base);
  if (
    proposal.applied !== false ||
    proposal.base.document_hash !== hash(before)
  )
    throw new Error("EVALUATION_PROPOSAL_BINDING");
  const document = apply_component_commands(
    build.base,
    proposal.commands,
    materials,
  );
  if (
    proposal.preview.document_hash !== hash(component_document_json(document))
  )
    throw new Error("EVALUATION_PREVIEW_BINDING");
  const reopened = JSON.parse(component_document_json(document));
  let history = edit_component_history(
    create_component_history(build.base),
    document,
  );
  const transforms = (snapshot) =>
    JSON.stringify(
      construction_instances(snapshot, materials).map(
        ({ asset, position, rotation, scale }) => [
          asset.id,
          asset.revision,
          position,
          rotation,
          scale,
        ],
      ),
    );
  const checks = {
    base_unchanged: before === component_document_json(build.base),
    one_undo_step: history.past.length === 1,
    undo:
      component_document_json(undo_component_history(history).present) ===
      before,
    redo:
      component_document_json(
        redo_component_history(undo_component_history(history)).present,
      ) === component_document_json(document),
    json_roundtrip:
      component_document_json(reopened) === component_document_json(document),
    seed_regeneration: transforms(reopened) === transforms(document),
  };
  return {
    ...measure_construction_build(document, materials, build.expected),
    invariants: checks,
  };
}
function model_actions(build, context) {
  const key = (id) =>
    context.materials.find((material) => material.name === id)?.key;
  const target = (id) => {
    const object = build.base.objects.findIndex((item) => item.id === id),
      scatter = build.base.scatters.findIndex((item) => item.id === id);
    const alias = object >= 0 ? `o${object + 1}` : `s${scatter + 1}`;
    return context.scene.targets.find((item) => item.key === alias)?.key;
  };
  return build.commands.map((command) => {
    switch (command.type) {
      case "set-floor":
        return command.floor
          ? {
              type: "floor",
              material: command.floor.asset
                ? key(command.floor.asset.id)
                : "none",
              size: command.floor.size,
              ...(command.floor.asset
                ? { texture: "t1", repeat: command.floor.texture_repeat }
                : {}),
            }
          : { type: "clear-floor" };
      case "place":
        return {
          type: "place",
          material: key(command.object.asset.id),
          position: command.object.position,
          rotation: command.object.rotation,
          scale: command.object.scale,
        };
      case "scatter":
        return {
          type: "scatter",
          material: key(command.rule.asset.id),
          seed: command.rule.seed,
          count: command.rule.count,
          bounds: command.rule.bounds,
          exclusions: command.rule.exclusions,
          scale_range: command.rule.scale,
        };
      case "transform":
        return {
          type: "transform",
          target: target(command.id),
          position: command.position,
          rotation: command.rotation,
          scale: command.scale,
        };
      case "remove":
        return { type: "remove", target: target(command.id) };
      default:
        throw new Error("EVALUATION_ACTION");
    }
  });
}
export async function run_scripted_build_evaluation() {
  const { materials, builds } = construction_builds(randomUUID),
    results = [];
  for (const build of builds) {
    let calls = 0;
    const descriptors = Object.values(materials),
      wanted = [
        ...new Set(
          build.commands
            .flatMap((command) => [
              command.floor?.asset?.id,
              command.object?.asset?.id,
              command.rule?.asset?.id,
            ])
            .filter(Boolean),
        ),
      ];
    const planner = create_construction_planner({
      catalog: {
        async search(query) {
          return {
            materials: descriptors
              .filter((entry) => entry.material.id === query)
              .map((entry) => entry.material),
            total: 1,
          };
        },
        async resolve(ref) {
          const found = materials[component_reference_key(ref)];
          if (!found) fail("CONSTRUCTION_CATALOG_CHANGED", 409);
          return found;
        },
      },
    });
    const proposal = await planner(
      {
        contract_version: 1,
        brief: build.brief,
        document: build.base,
        ...(build.guidance ? { guidance: build.guidance } : {}),
      },
      {
        signal: AbortSignal.timeout(10000),
        generate: async (request) => {
          generation_request(request);
          const context = JSON.parse(request.messages[1].content);
          const structured =
            ++calls === 1
              ? {
                  queries: wanted,
                  recipe: wanted.includes("tree")
                    ? "wooded-path-v1"
                    : wanted.length
                      ? "ground-cover-v1"
                      : "none",
                }
              : request.schema.properties.corridor_width
                ? (() => {
                    const floor = build.commands.find(
                      (command) => command.type === "set-floor",
                    ).floor;
                    const rule = build.commands.find(
                      (command) => command.type === "scatter",
                    ).rule;
                    const exclusion = rule.exclusions[0];
                    return {
                      size: floor.size,
                      corridor_axis: "z",
                      corridor_width: exclusion[2] - exclusion[0],
                      corridor_center: (exclusion[0] + exclusion[2]) / 2,
                      seed: rule.seed,
                      ...Object.fromEntries(
                        ["grass", "shrub", "tree"].map((role) => [
                          role,
                          {
                            count: build.commands
                              .filter(
                                (command) => command.rule?.asset.id === role,
                              )
                              .reduce(
                                (sum, command) => sum + command.rule.count,
                                0,
                              ),
                            height_m: null,
                            scale_range: null,
                          },
                        ]),
                      ),
                      questions: [],
                    };
                  })()
                : {
                    summary: "Scripted representative build proposal.",
                    questions: [],
                    assumptions: [],
                    actions: model_actions(build, context),
                  };
          return { structured, finish_reason: "stop" };
        },
      },
    );
    const measured = evaluate_proposal(build, proposal, materials),
      expected_pass = build.expected_pass !== false;
    results.push({
      case: build.id,
      source: "scripted_generation",
      expected_pass,
      ...measured,
      harness_pass:
        measured.passed === expected_pass &&
        Object.values(measured.invariants).every(Boolean),
      generation_calls: calls,
    });
  }
  const baseline = results.find(
      (result) => result.case === "memory-without-guidance",
    ),
    guided = results.find((result) => result.case === "memory-with-guidance");
  return {
    source: "scripted_generation_not_model_quality",
    cases: results,
    faults: await evaluate_faults(materials, builds),
    memory_comparison: {
      metric: "failed_scene_criteria_proxy_not_human_corrections",
      without_guidance: baseline.correction_proxy,
      with_guidance: guided.correction_proxy,
      live_benefit: "not_measured",
    },
  };
}
async function evaluate_faults(materials, builds) {
  const wooded = builds.find((build) => build.id === "wooded-path"),
    base = apply_component_commands(wooded.base, wooded.commands, materials),
    before = component_document_json(base),
    results = [];
  for (const fault of [
    "missing-material",
    "uncalibrated-material",
    "catalog-unavailable",
    "engine-unavailable",
    "stale-revision",
    "impossible-fill",
  ]) {
    let calls = 0;
    const resolved = new Set();
    const incomplete = material_view(
      {
        id: "grass",
        name: "grass",
        construction: empty_material_construction(),
      },
      "b".repeat(64),
    );
    const catalog = {
      async search(query) {
        if (fault === "catalog-unavailable")
          fail("CONSTRUCTION_CATALOG_UNAVAILABLE", 503);
        const material = Object.values(materials).find(
          (entry) => entry.material.id === query,
        )?.material;
        const found =
          fault === "missing-material"
            ? []
            : fault === "uncalibrated-material"
              ? [incomplete]
              : material
                ? [material]
                : [];
        return { materials: found, total: found.length };
      },
      async resolve(ref) {
        if (fault === "stale-revision" && resolved.has(ref.id))
          fail("CONSTRUCTION_CATALOG_CHANGED", 409);
        resolved.add(ref.id);
        return materials[component_reference_key(ref)];
      },
    };
    const body = { contract_version: 1, brief: wooded.brief, document: base };
    try {
      const proposal = await create_construction_planner({ catalog })(body, {
        signal: AbortSignal.timeout(10000),
        generate: async (request) => {
          if (fault === "engine-unavailable")
            throw new EngineError("ENGINE_UNAVAILABLE");
          generation_request(request);
          const context = JSON.parse(request.messages[1].content),
            gap = ["missing-material", "uncalibrated-material"].includes(fault);
          const commands =
            fault === "impossible-fill"
              ? [
                  {
                    type: "scatter",
                    rule: {
                      ...wooded.commands.at(-1).rule,
                      count: 1000,
                      bounds: [0, 0, 1, 1],
                      exclusions: [],
                    },
                  },
                ]
              : wooded.commands;
          const structured =
            ++calls === 1
              ? {
                  queries: gap ? ["grass"] : ["dirt", "grass", "shrub", "tree"],
                  recipe: "wooded-path-v1",
                }
              : {
                  summary: "Scripted failure-path evaluation.",
                  questions: gap
                    ? ["Supply calibrated requested material."]
                    : [],
                  assumptions: [],
                  actions: gap
                    ? []
                    : model_actions({ ...wooded, commands }, context),
                };
          return { structured, finish_reason: "stop" };
        },
      });
      results.push({
        case: fault,
        outcome: "needs_information",
        passed:
          proposal.status === "needs_information" &&
          proposal.commands.length === 0 &&
          proposal.information_needed.some(
            (gap) =>
              gap.reason ===
              (fault === "missing-material"
                ? "not_found"
                : "calibration_required"),
          ) &&
          component_document_json(base) === before,
      });
    } catch (error) {
      const expected = {
        "catalog-unavailable": "CONSTRUCTION_CATALOG_UNAVAILABLE",
        "engine-unavailable": "ENGINE_UNAVAILABLE",
        "stale-revision": "CONSTRUCTION_CATALOG_CHANGED",
        "impossible-fill": "CONSTRUCTION_INVALID_PLAN",
      }[fault];
      results.push({
        case: fault,
        outcome: "rejected",
        error: error.code || error.message,
        passed:
          (error.code || error.message) === expected &&
          component_document_json(base) === before,
      });
    }
  }
  return results;
}
