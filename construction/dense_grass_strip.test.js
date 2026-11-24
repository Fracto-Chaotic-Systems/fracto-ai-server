import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  create_component_document,
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
import { empty_material_construction } from "@fracto/sdk/FractoMaterialMetadata.js";
import recipe from "./dense_grass_strip_recipe.json" with { type: "json" };
import {
  compile_dense_grass,
  dense_grass_bindings,
} from "./dense_grass_strip.js";
import { create_construction_planner } from "./planner.js";
import {
  GRASS_STRIP_BRIEF,
  measure_dense_grass,
} from "./dense_grass_evaluation.js";
import { compile_schema } from "../engines/contracts.js";
import { translate_actions } from "./translate.js";

const fixture = () => {
  const grass = {
    material: {
      ...recipe.grass,
      name: "yard_grass_motion",
      category: "grass",
      tags: ["grass"],
      description: "",
      placement_ready: true,
      missing_metadata: [],
      construction: {
        ...empty_material_construction(),
        kind: "model",
        placement: "ground",
        meters_per_unit: 0.05,
        dimensions_m: [1.617138, 0.5173413, 1.4689622],
        footprint_m: [1.617138, 1.4689622],
        up_axis: "y",
        forward_axis: "z",
        ground_anchor_m: [-0.0246376, -0.0342186, 0.0009845],
      },
    },
    runtime: { model: "grass.glb", format: "glb", resources: ["grass.glb"] },
    textures: {},
  };
  const surface = {
    material: {
      ...recipe.surface,
      name: "dry_dirt",
      category: "dirt",
      tags: ["dirt"],
      description: "",
      placement_ready: true,
      missing_metadata: [],
      construction: {
        ...empty_material_construction(),
        kind: "surface",
        placement: "floor",
        texture_size_m: [1, 1],
      },
    },
    runtime: { model: null, format: null, resources: [recipe.texture_file] },
    textures: { t1: recipe.texture_file },
  };
  const context = { m1: grass, m2: surface };
  return {
    context,
    materials: Object.fromEntries(
      [grass, surface].map((e) => [component_reference_key(e.material), e]),
    ),
    base: create_component_document(randomUUID(), "Strip"),
    bindings: { grass: "m1", surface: "m2" },
  };
};

test("reviewed strip reproduces corrected transforms, full coverage and one undoable batch", () => {
  const f = fixture();
  const output = compile_dense_grass(
    { size: [1, 20], questions: [] },
    f.bindings,
    f.context,
  );
  const translated = translate_actions(output.actions, f.context, {});
  const commands = [...translated.commands, output.pattern];
  const document = apply_component_commands(f.base, commands, f.materials);
  assert.equal(measure_dense_grass(document, f.materials).passed, true);
  assert.deepEqual(
    document.objects.map((o) => [
      o.position[0],
      o.position[2],
      o.rotation[1],
      o.scale[0],
    ]),
    recipe.placements,
  );
  assert.deepEqual(
    JSON.parse(component_document_json(document)),
    JSON.parse(
      component_document_json(
        apply_component_commands(
          f.base,
          JSON.parse(JSON.stringify(commands)),
          f.materials,
        ),
      ),
    ),
  );
  const history = edit_component_history(
    create_component_history(f.base),
    document,
  );
  assert.deepEqual(undo_component_history(history).present, f.base);
  assert.deepEqual(
    redo_component_history(undo_component_history(history)).present,
    document,
  );
  assert.deepEqual(f.base.objects, []);
  assert.throws(() =>
    apply_component_commands(
      f.base,
      [
        commands[0],
        {
          ...output.pattern,
          instances: [...output.pattern.instances, output.pattern.instances[0]],
        },
      ],
      f.materials,
    ),
  );
  assert.throws(() =>
    apply_component_commands(
      f.base,
      [
        {
          ...output.pattern,
          instances: Array(1001).fill(output.pattern.instances[0]),
        },
      ],
      f.materials,
    ),
  );
  assert.throws(() => apply_component_commands(f.base, commands, {}));
});

test("recipe guards edits, changed pins, unsupported constraints and scales", () => {
  const f = fixture();
  assert.deepEqual(
    dense_grass_bindings(recipe.id, f.base, f.context),
    f.bindings,
  );
  assert.equal(
    dense_grass_bindings(recipe.id, { ...f.base, floor: {} }, f.context),
    null,
  );
  assert.equal(dense_grass_bindings("none", f.base, f.context), null);
  assert.equal(
    compile_dense_grass({ size: [2, 20], questions: [] }, f.bindings, f.context)
      .actions.length,
    0,
  );
  assert.equal(
    compile_dense_grass(
      { size: [1, 20], questions: ["Choose a corridor."] },
      f.bindings,
      f.context,
    ).actions.length,
    0,
  );
  const scaled = compile_dense_grass(
    { size: [0.5, 10], questions: [] },
    f.bindings,
    f.context,
  );
  assert.equal(scaled.pattern.instances.length, 809);
  assert.deepEqual(scaled.pattern.instances[0].scale, [0.275, 0.275, 0.275]);
  f.context.m1.material.revision = "a".repeat(64);
  assert.equal(
    compile_dense_grass({ size: [1, 20], questions: [] }, f.bindings, f.context)
      .actions.length,
    0,
  );
});

test("planner extracts bounded dimensions and returns compact pinned recipe commands", async () => {
  const f = fixture();
  f.base.animation_speed = 0.25;
  const catalog = {
    search: async (q) => ({
      total: 1,
      materials: [f.context[q === "yard_grass_motion" ? "m1" : "m2"].material],
    }),
    resolve: async (ref) => {
      const e = f.materials[component_reference_key(ref)];
      if (!e) throw Error("stale");
      return e;
    },
  };
  let calls = 0;
  const plan = await create_construction_planner({ catalog })(
    { contract_version: 1, brief: GRASS_STRIP_BRIEF, document: f.base },
    {
      signal: AbortSignal.timeout(5000),
      generate: async ({ schema }) => {
        const structured = calls++
          ? { size: [1, 20], questions: [] }
          : { queries: ["dense-grass-strip-v1"], recipe: recipe.id };
        assert.equal(compile_schema(schema).validate(structured), true);
        return { structured, finish_reason: "stop" };
      },
    },
  );
  assert.equal(calls, 2);
  assert.equal(plan.status, "proposal");
  assert.equal(plan.commands.length, 2);
  assert.equal(plan.preview.objects, 809);
  assert.ok(Buffer.byteLength(JSON.stringify(plan)) < 256 * 1024);
  const preview = apply_component_commands(f.base, plan.commands, f.materials);
  assert.equal(preview.animation_speed, 0.25);
  assert.equal(measure_dense_grass(preview, f.materials).passed, true);
  preview.objects.splice(1);
  assert.equal(
    measure_dense_grass(preview, f.materials).checks.full_sampled_coverage,
    false,
  );
});
