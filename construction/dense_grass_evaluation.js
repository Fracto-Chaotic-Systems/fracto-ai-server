import { randomUUID } from "node:crypto";
import {
  create_component_document,
  component_document_json,
} from "@fracto/sdk/FractoComponentDocument.js";
import {
  apply_component_commands,
  component_reference_key,
} from "@fracto/sdk/FractoComponentTools.js";
import { hash } from "../inference/contracts.js";

export const GRASS_STRIP_BRIEF =
  "Make a strip of grass 1m wide and 20m long, filling it completely with yard_grass_motion with a background texture of dry_dirt.";

// Independent scene measurements, not the recipe compiler or a model judge.
// Measures footprint coverage at 1 cm centers; not grass-blade/alpha coverage.
export function measure_dense_grass(document, materials) {
  const rectangles = document.objects.map((o) => {
    const facts =
      materials[component_reference_key(o.asset)]?.material.construction;
    if (!facts) throw Error("EVALUATION_MATERIAL_MISSING");
    const [w, d] = facts.footprint_m,
      s = o.scale[0],
      yaw = o.rotation[1];
    const hx =
      ((Math.abs(Math.cos(yaw)) * w + Math.abs(Math.sin(yaw)) * d) * s) / 2;
    const hz =
      ((Math.abs(Math.sin(yaw)) * w + Math.abs(Math.cos(yaw)) * d) * s) / 2;
    return [
      o.position[0] - hx,
      o.position[2] - hz,
      o.position[0] + hx,
      o.position[2] + hz,
    ];
  });
  const outside = rectangles.filter(
    ([x0, z0, x1, z1]) =>
      x0 < -0.5 - 2e-7 || z0 < -10 - 2e-7 || x1 > 0.5 + 2e-7 || z1 > 10 + 2e-7,
  ).length;
  let uncovered = 0;
  for (let row = 0; row < 2000; row++) {
    const z = -10 + (row + 0.5) * 0.01;
    const intervals = rectangles
      .filter((r) => r[1] <= z && r[3] >= z)
      .map((r) => [r[0], r[2]])
      .sort((a, b) => a[0] - b[0]);
    for (let col = 0; col < 100; col++) {
      const x = -0.5 + (col + 0.5) * 0.01;
      if (!intervals.some(([lo, hi]) => lo <= x && x <= hi)) uncovered++;
    }
  }
  const checks = {
    floor_size: JSON.stringify(document.floor?.size) === "[1,20]",
    requested_surface:
      document.floor?.asset?.id === "dry-dirt" &&
      /surface-base-color/.test(document.floor?.texture_file || ""),
    physical_texture_repeat:
      JSON.stringify(document.floor?.texture_repeat) === "[1,20]",
    requested_grass: document.objects.every((o) => o.asset.id === "yard-grass"),
    dense_pattern:
      document.objects.length === 809 &&
      document.scatters.length === 0 &&
      document.objects.filter((o) => o.scale.every((s) => s === 0.55))
        .length === 387 &&
      document.objects.filter((o) => o.scale.every((s) => s === 0.15))
        .length === 422,
    grounded: document.objects.every(
      (o) => o.position[1] === 0 && o.rotation[0] === 0 && o.rotation[2] === 0,
    ),
    within_bounds: outside === 0,
    full_sampled_coverage: uncovered === 0,
  };
  return {
    passed: Object.values(checks).every(Boolean),
    checks,
    instances: document.objects.length,
    outside_footprints: outside,
    coverage_samples: 200000,
    uncovered_samples: uncovered,
  };
}

export async function run_live_dense_grass({
  plan,
  catalog,
  on_case = () => {},
}) {
  on_case("dense-grass-strip");
  const start = performance.now();
  const document = create_component_document(
    randomUUID(),
    "Dense grass recipe evaluation",
  );
  const proposal = await plan({
    contract_version: 1,
    brief: GRASS_STRIP_BRIEF,
    document,
  });
  const materials = {};
  for (const ref of proposal.commands.flatMap((c) =>
    [c.asset, c.floor?.asset, c.object?.asset, c.rule?.asset].filter(Boolean),
  ))
    materials[component_reference_key(ref)] = await catalog.resolve(
      ref,
      AbortSignal.timeout(20000),
    );
  const preview = proposal.commands.length
    ? apply_component_commands(document, proposal.commands, materials)
    : document;
  const measured = measure_dense_grass(preview, materials);
  measured.checks.proposal_binding =
    proposal.applied === false &&
    proposal.base.document_hash === hash(component_document_json(document)) &&
    proposal.preview.document_hash === hash(component_document_json(preview));
  measured.checks.ready_proposal =
    proposal.status === "proposal" &&
    proposal.questions.length === 0 &&
    proposal.information_needed.length === 0;
  measured.checks.reviewed_recipe = proposal.recipe === "dense-grass-strip-v1";
  measured.passed = Object.values(measured.checks).every(Boolean);
  return {
    cases: [
      {
        case: "dense-grass-strip",
        outcome: measured.passed ? "pass" : "fail",
        brief: GRASS_STRIP_BRIEF,
        elapsed_ms: Math.round(performance.now() - start),
        recipe: proposal.recipe,
        proposal_status: proposal.status,
        questions: proposal.questions,
        information_needed: proposal.information_needed,
        planner_timings_ms: proposal.timings_ms,
        ...measured,
        preview_document: preview,
      },
    ],
    memory_benefit: "not_measured",
  };
}
