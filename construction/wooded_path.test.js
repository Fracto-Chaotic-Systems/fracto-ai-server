import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { construction_builds } from "@fracto/sdk/testing/ConstructionBuilds.js";
import { apply_component_commands } from "@fracto/sdk/FractoComponentTools.js";
import { generate_component_scatter } from "@fracto/sdk/FractoComponentScatter.js";
import {
  component_document_json,
  create_component_history,
  edit_component_history,
  undo_component_history,
  redo_component_history,
} from "@fracto/sdk/FractoComponentDocument.js";
import { fail } from "../inference/contracts.js";
import { compile_schema } from "../engines/contracts.js";
import { create_construction_planner } from "./planner.js";
import { translate_actions } from "./translate.js";
import { compile_wooded_path } from "./wooded_path.js";
import {
  wooded_path_bindings,
  wooded_path_schema,
} from "./wooded_path_contract.js";

function fixture() {
  const { materials, builds } = construction_builds(randomUUID);
  const context = Object.fromEntries(
    Object.values(materials).map((entry, i) => [
      `m${i + 1}`,
      {
        ...entry,
        textures: entry.material.id === "dirt" ? { t1: "dirt.png" } : {},
      },
    ]),
  );
  const tree = Object.values(context).find(
    (entry) => entry.material.id === "tree",
  );
  // Broad calibrated canopy, unlike the small synthetic renderer fixture.
  Object.assign(tree.material.construction, {
    dimensions_m: [11.1, 9.4, 11.5],
    footprint_m: [11.1, 11.5],
  });
  const base = builds[0].base;
  const bindings = wooded_path_bindings("wooded-path-v1", base, context);
  return { materials, context, base, bindings };
}
const params = (overrides) => ({
  size: [8, 20],
  corridor_axis: "z",
  corridor_width: 2,
  corridor_center: 0,
  seed: 1,
  grass: { count: 40, height_m: null, scale_range: null },
  shrub: { count: 6, height_m: null, scale_range: null },
  tree: { count: 4, height_m: null, scale_range: null },
  questions: [],
  ...overrides,
});

function verify(parameters, f) {
  assert.equal(compile_schema(wooded_path_schema).validate(parameters), true);
  const before = component_document_json(f.base);
  const output = compile_wooded_path(parameters, f.bindings, f.context);
  assert.deepEqual(output.questions, []);
  const translated = translate_actions(output.actions, f.context, {});
  const document = apply_component_commands(
    f.base,
    translated.commands,
    f.materials,
  );
  assert.equal(component_document_json(f.base), before);
  const history = edit_component_history(
    create_component_history(f.base),
    document,
  );
  assert.equal(history.past.length, 1);
  assert.equal(
    component_document_json(undo_component_history(history).present),
    before,
  );
  assert.equal(
    component_document_json(
      redo_component_history(undo_component_history(history)).present,
    ),
    component_document_json(document),
  );
  assert.deepEqual(document.floor.size, parameters.size);
  assert.deepEqual(document.floor.texture_repeat, parameters.size);
  for (const rule of document.scatters) {
    const role = rule.asset.id;
    assert.equal(rule.count, parameters[role].count);
    const facts = Object.values(f.materials).find(
      (entry) => entry.material.id === role,
    ).material.construction;
    const expanded = generate_component_scatter(rule, facts);
    const reloaded = JSON.parse(
      component_document_json(document),
    ).scatters.find((item) => item.id === rule.id);
    assert.deepEqual(generate_component_scatter(reloaded, facts), expanded);
    assert.equal(expanded.length, parameters[role].count);
    for (const instance of expanded) {
      const [w, d] = facts.footprint_m,
        yaw = instance.rotation[1],
        scale = instance.scale[0];
      const corners = [
        [-w / 2, -d / 2],
        [-w / 2, d / 2],
        [w / 2, -d / 2],
        [w / 2, d / 2],
      ].map(([x, z]) => [
        instance.position[0] + scale * (x * Math.cos(yaw) + z * Math.sin(yaw)),
        instance.position[2] + scale * (-x * Math.sin(yaw) + z * Math.cos(yaw)),
      ]);
      for (const [x, z] of corners) {
        assert.ok(Math.abs(x) <= parameters.size[0] / 2);
        assert.ok(Math.abs(z) <= parameters.size[1] / 2);
      }
      const axis = parameters.corridor_axis === "z" ? 0 : 1;
      const values = corners.map((corner) => corner[axis]);
      assert.ok(
        Math.max(...values) <
          parameters.corridor_center - parameters.corridor_width / 2 ||
          Math.min(...values) >
            parameters.corridor_center + parameters.corridor_width / 2,
      );
    }
  }
  return { document, output };
}

test("changed catalog pins reject a recipe instead of returning a stale compiled proposal", async () => {
  const f = fixture();
  let calls = 0,
    resolves = 0;
  const planner = create_construction_planner({
    catalog: {
      search: async (query) => ({
        total: 1,
        materials: [
          Object.values(f.context).find((entry) => entry.material.id === query)
            .material,
        ],
      }),
      resolve: async (ref) => {
        if (++resolves > 4 && ref.id === "tree")
          fail("CONSTRUCTION_CATALOG_CHANGED", 409);
        return Object.values(f.context).find(
          (entry) => entry.material.id === ref.id,
        );
      },
    },
  });
  await assert.rejects(
    () =>
      planner(
        { contract_version: 1, brief: "A new wooded path.", document: f.base },
        {
          signal: AbortSignal.timeout(5000),
          generate: async () => ({
            finish_reason: "stop",
            structured:
              ++calls === 1
                ? {
                    queries: ["dirt", "grass", "shrub", "tree"],
                    recipe: "wooded-path-v1",
                  }
                : params(),
          }),
        },
      ),
    (error) => error.code === "CONSTRUCTION_CATALOG_CHANGED",
  );
  assert.equal(f.base.floor, null);
  assert.equal(f.base.scatters.length, 0);
});

test("reviewed recipe keeps exact role counts and all rotated footprints clear over varied seeds", () => {
  for (const seed of [0, 1, 19, 83, 0xffffffff]) {
    const { document, output } = verify(params({ seed }), fixture());
    assert.deepEqual(
      document.scatters.map((rule) => rule.count),
      [40, 6, 4],
    );
    assert.match(output.assumptions.join(" "), /automatic fit/);
    assert.ok(
      document.scatters[2].scale[1] < 0.2,
      "broad tree canopies are actually scaled to fit",
    );
  }
});
test("counts, dimensions, corridor direction and offset are parameters rather than evaluation constants", () => {
  verify(
    params({
      size: [30, 12],
      corridor_axis: "x",
      corridor_width: 3,
      corridor_center: 1,
      seed: 55,
      grass: { count: 17, height_m: 0.3, scale_range: null },
      shrub: { count: 3, height_m: null, scale_range: [0.7, 0.8] },
      tree: { count: 7, height_m: null, scale_range: null },
    }),
    fixture(),
  );
});
test("impossible explicit constraints return questions with no partial floor or plant edits", () => {
  for (const changes of [
    { corridor_width: 8 },
    { corridor_center: 4 },
    { grass: { count: 1000, height_m: null, scale_range: null } },
    { tree: { count: 4, height_m: 5, scale_range: null } },
    { shrub: { count: 6, height_m: 1, scale_range: [0.2, 0.3] } },
    { questions: ["Which individual positions should be used?"] },
  ]) {
    const f = fixture(),
      output = compile_wooded_path(params(changes), f.bindings, f.context);
    assert.ok(output.questions.length);
    assert.deepEqual(output.actions, []);
  }
});
test("recipe does not replace existing scenes or silently use multi-tree groups", () => {
  const f = fixture();
  assert.equal(wooded_path_bindings("none", f.base, f.context), null);
  assert.equal(
    wooded_path_bindings("wooded-path-v1", { ...f.base, floor: {} }, f.context),
    null,
  );
  f.context[f.bindings.tree].material.tags.push("group");
  assert.equal(wooded_path_bindings("wooded-path-v1", f.base, f.context), null);
});
test("real planner routes validated parameters through SDK replay and rechecks material pins", async () => {
  const f = fixture(),
    calls = [];
  let resolves = 0;
  const planner = create_construction_planner({
    catalog: {
      search: async (query) => ({
        total: 1,
        materials: [
          Object.values(f.context).find((entry) => entry.material.id === query)
            .material,
        ],
      }),
      resolve: async (ref) => {
        resolves++;
        return Object.values(f.context).find(
          (entry) => entry.material.id === ref.id,
        );
      },
    },
  });
  const proposal = await planner(
    {
      contract_version: 1,
      brief: "A wooded path with exact plant counts.",
      document: f.base,
      guidance: [
        { kind: "preference", instructions: "Prefer a narrow corridor." },
      ],
    },
    {
      signal: AbortSignal.timeout(5000),
      generate: async (request) => {
        calls.push(request);
        return {
          finish_reason: "stop",
          structured:
            calls.length === 1
              ? {
                  queries: ["dirt", "grass", "shrub", "tree"],
                  recipe: "wooded-path-v1",
                }
              : params(),
        };
      },
    },
  );
  assert.equal(calls.length, 2);
  assert.ok(calls[1].schema.properties.corridor_width);
  assert.match(JSON.stringify(calls[1].messages), /Prefer a narrow corridor/);
  assert.equal(proposal.status, "proposal");
  assert.equal(proposal.preview.total_instances, 50);
  assert.deepEqual(
    proposal.commands.slice(1).map((command) => command.rule.count),
    [40, 6, 4],
  );
  assert.equal(
    resolves,
    8,
    "every referenced pin is rechecked after extraction",
  );
});
