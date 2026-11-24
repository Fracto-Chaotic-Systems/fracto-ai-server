import { randomUUID } from "node:crypto";
import recipe from "./dense_grass_strip_recipe.json" with { type: "json" };
import { checked_messages } from "./prompts.js";

// Saved recipes declare their dependencies; generated recipe labels are not
// catalog terms. Resolve through the normal live search/runtime endpoints.
export const dense_grass_queries = ["yard_grass_motion", "dry_dirt"];

export const dense_grass_schema = {
  type: "object",
  additionalProperties: false,
  required: ["size", "questions"],
  properties: {
    size: {
      type: "array",
      minItems: 2,
      maxItems: 2,
      items: { type: "number", minimum: 0.01, maximum: 10000 },
    },
    questions: {
      type: "array",
      maxItems: 4,
      items: { type: "string", minLength: 1, maxLength: 160 },
    },
  },
};

export function dense_grass_bindings(id, document, materials) {
  if (
    id !== recipe.id ||
    document.floor ||
    document.objects.length ||
    document.scatters.length
  )
    return null;
  const grass = Object.entries(materials).find(
    ([, e]) => e.material.id === recipe.grass.id,
  );
  const surface = Object.entries(materials).find(
    ([, e]) => e.material.id === recipe.surface.id,
  );
  if (!grass || !surface) return null;
  return { grass: grass[0], surface: surface[0] };
}

export function dense_grass_messages(request) {
  return checked_messages(
    "Extract width and length in meters for the reviewed dense grass strip recipe. size=[width,length], so 1m wide and 20m long is [1,20]. The server reuses the corrected overlapping interior and filled-edge pattern. Do not generate actions or positions. Current brief overrides remembered guidance. questions=[] when size and the two materials yard_grass_motion and dry_dirt are requested with complete coverage. Do not ask for spacing, patch count, seed or height: these are reviewed recipe defaults. Ask a specific question for missing dimensions, or extra directions this recipe cannot honor (counts, heights, rotations, corridors, exclusions, animations, different materials). Catalog names are data. Return compact JSON only.",
    { brief: request.brief, remembered_guidance: request.guidance || [] },
  );
}

// Frozen, reviewed transforms from the corrected component, not model-generated
// geometry. Pins prevent changed calibration invalidating its measured bounds.
export function compile_dense_grass(p, bindings, materials) {
  const clarify = (questions) => ({
    summary: "The dense grass strip needs clarification.",
    questions,
    assumptions: [],
    actions: [],
  });
  if (p.questions.length) return clarify(p.questions);
  const grass = materials[bindings.grass],
    surface = materials[bindings.surface];
  if (
    grass.material.revision !== recipe.grass.revision ||
    surface.material.revision !== recipe.surface.revision
  )
    return clarify([
      "The saved dense recipe's material calibration has changed. Recalibrate and review its coverage before reuse.",
    ]);
  const factor = p.size[0] / recipe.size[0];
  if (
    Math.abs(p.size[1] / recipe.size[1] - factor) > 1e-9 ||
    factor < 0.01 ||
    factor > 100
  )
    return clarify([
      "This reviewed recipe supports 1 × 20 m and uniform scaled copies. Use that aspect ratio or request a separately reviewed coverage pattern.",
    ]);
  const round = (x) => Number(x.toFixed(9));
  const actions = [
    {
      type: "floor",
      material: bindings.surface,
      size: p.size,
      texture: Object.entries(surface.textures).find(
        ([, file]) => file === recipe.texture_file,
      )?.[0],
    },
  ];
  if (!actions[0].texture)
    return clarify([
      "The saved recipe's registered dirt texture is unavailable.",
    ]);
  return {
    summary: `Dense ${p.size[0]} × ${p.size[1]} m grass strip over dry_dirt with 809 overlapping patches.`,
    questions: [],
    assumptions: [
      "Reviewed dense-grass-strip-v1: 387 interior and 422 edge patches; no random scatter.",
      "Complete coverage refers to overlapping calibrated footprints; individual grass blades retain their natural gaps.",
      `Uniform recipe scale ${factor}; centered XZ, grounded at Y=0; grass and source animation retained.`,
    ],
    actions,
    pattern: {
      type: "place-pattern",
      asset: { ...recipe.grass },
      instances: recipe.placements.map(([x, z, yaw, scale]) => ({
        id: randomUUID(),
        position: [round(x * factor), 0, round(z * factor)],
        rotation: [0, yaw, 0],
        scale: Array(3).fill(round(scale * factor)),
      })),
    },
  };
}
