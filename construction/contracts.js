import { compile_schema } from "../engines/contracts.js";
import { fail } from "../inference/contracts.js";
import { validate_component_document } from "@fracto/sdk/FractoComponentDocument.js";
import { validate_construction_guidance } from "@fracto/sdk/FractoConstructionMemory.js";
export const PLANNER_VERSION = "construction-planner-v1";
export const RECIPES = Object.freeze({
  none: "No specific recipe. Use the brief and ask about material or calibration gaps.",
  "wooded-path-v1":
    "A centered walking corridor, optional dirt floor, grass borders, shrub clusters and spaced trees. Exclude the walking corridor from every scatter using footprint clearance. State assumed corridor dimensions. Do not silently replace requested materials.",
  "ground-cover-v1":
    "Use calibrated ground material, bounded seeded scatter and explicit exclusions. Use small batches and state density/scale assumptions.",
  "dense-grass-strip-v1":
    "Reproduce the reviewed continuous 1 m by 20 m yard_grass_motion strip over dry_dirt: 387 overlapping interior patches and 422 perimeter patches. Uniformly scaled copies are supported; no random scatter or bare margins.",
});
export const exact = (value, required, optional = []) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  required.every((key) => Object.hasOwn(value, key)) &&
  Object.keys(value).every((key) => [...required, ...optional].includes(key));
export function construction_request(body) {
  if (
    !exact(body, ["contract_version", "brief", "document"], ["guidance"]) ||
    body.contract_version !== 1 ||
    typeof body.brief !== "string" ||
    !body.brief.trim() ||
    body.brief.length > 1000 ||
    Buffer.byteLength(body.brief) > 2048 ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(body.brief)
  )
    fail("CONSTRUCTION_INVALID_REQUEST");
  try {
    const request = {
      contract_version: 1,
      brief: body.brief.trim().replace(/\s+/g, " "),
      document: validate_component_document(body.document),
    };
    if (Object.hasOwn(body, "guidance"))
      request.guidance = validate_construction_guidance(body.guidance);
    return request;
  } catch {
    fail("CONSTRUCTION_INVALID_REQUEST");
  }
}
const text = (max) => ({ type: "string", minLength: 1, maxLength: max });
const vector = (length, min, max) => ({
  type: "array",
  minItems: length,
  maxItems: length,
  items: { type: "number", minimum: min, maximum: max },
});
export const search_schema = {
  type: "object",
  additionalProperties: false,
  required: ["queries", "recipe"],
  properties: {
    queries: { type: "array", maxItems: 4, items: text(80) },
    recipe: { type: "string", enum: Object.keys(RECIPES) },
  },
};
export function action_schema(materials, targets, { has_floor = true } = {}) {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["summary", "questions", "assumptions", "actions"],
    properties: {
      summary: text(240),
      questions: { type: "array", maxItems: 4, items: text(160) },
      assumptions: { type: "array", maxItems: 4, items: text(160) },
      actions: {
        type: "array",
        maxItems: 8,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["type"],
          properties: {
            type: {
              type: "string",
              enum: [
                "floor",
                "clear-floor",
                "place",
                "transform",
                "remove",
                "scatter",
              ],
            },
            material: {
              type: "string",
              enum: ["none", ...Object.keys(materials)],
            },
            target: { type: "string", enum: ["none", ...Object.keys(targets)] },
            texture: { type: "string", enum: ["t1", "t2", "t3"] },
            size: vector(2, 0.01, 10000),
            repeat: vector(2, 0.001, 10000),
            position: vector(3, -10000, 10000),
            rotation: vector(3, -Math.PI * 2, Math.PI * 2),
            scale: vector(3, 0.001, 1000),
            seed: { type: "integer", minimum: 0, maximum: 4294967295 },
            count: { type: "integer", minimum: 0, maximum: 1000 },
            bounds: vector(4, -10000, 10000),
            exclusions: {
              type: "array",
              maxItems: 8,
              items: vector(4, -10000, 10000),
            },
            scale_range: vector(2, 0.001, 1000),
          },
        },
      },
    },
  };
  const fields = schema.properties.actions.items.properties;
  const shape = (type, required, optional = [], overrides = {}) => ({
    type: "object",
    additionalProperties: false,
    required: ["type", ...required],
    properties: Object.fromEntries(
      ["type", ...required, ...optional].map((key) => [
        key,
        key === "type"
          ? { type: "string", const: type }
          : overrides[key]
            ? { type: "string", ...overrides[key] }
            : fields[key],
      ]),
    ),
  });
  const models = Object.keys(materials).filter(
    (key) => materials[key].material.construction.kind === "model",
  );
  const ground = models.filter(
    (key) => materials[key].material.construction.placement === "ground",
  );
  const surfaces = Object.keys(materials).filter(
    (key) => materials[key].material.construction.kind === "surface",
  );
  const objects = Object.keys(targets).filter(
    (key) => targets[key].kind === "object",
  );
  const scatters = Object.keys(targets).filter(
    (key) => targets[key].kind === "scatter",
  );
  const alternatives = [];
  if (surfaces.length)
    alternatives.push(
      shape("floor", ["material", "size", "texture"], ["repeat"], {
        material: { enum: surfaces },
      }),
    );
  alternatives.push(
    shape("floor", ["material", "size"], ["repeat"], {
      material: { const: "none" },
    }),
  );
  if (has_floor) alternatives.push(shape("clear-floor", []));
  if (models.length)
    alternatives.push(
      shape("place", ["material", "position", "rotation", "scale"], [], {
        material: { enum: models },
      }),
    );
  if (objects.length)
    alternatives.push(
      shape("transform", ["target", "position", "rotation", "scale"], [], {
        target: { enum: objects },
      }),
    );
  if (Object.keys(targets).length)
    alternatives.push(
      shape("remove", ["target"], [], {
        target: { enum: Object.keys(targets) },
      }),
    );
  if (ground.length)
    alternatives.push(
      shape(
        "scatter",
        ["material", "seed", "count", "bounds", "exclusions", "scale_range"],
        scatters.length ? ["target"] : [],
        {
          material: { enum: ground },
          ...(scatters.length ? { target: { enum: scatters } } : {}),
        },
      ),
    );
  schema.properties.actions.items = {
    oneOf: alternatives,
  };
  return schema;
}
export function checked_output(result, schema) {
  const output = result?.structured;
  if (
    result?.finish_reason === "length" ||
    !compile_schema(schema).validate(output) ||
    Buffer.byteLength(JSON.stringify(output)) > 8192
  )
    fail("CONSTRUCTION_INVALID_OUTPUT", 502);
  return output;
}
