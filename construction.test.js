import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import {
  create_component_document,
  component_document_json,
} from "@fracto/sdk/FractoComponentDocument.js";
import {
  empty_material_construction,
  material_view,
} from "@fracto/sdk/FractoMaterialMetadata.js";
import {
  apply_component_commands,
  component_reference_key,
} from "@fracto/sdk/FractoComponentTools.js";
import { create_construction_planner } from "./construction/planner.js";
import { create_construction_catalog } from "./construction/catalog.js";
import { construction_request } from "./construction/contracts.js";
import { InferenceService } from "./inference/service.js";
import { EngineError } from "./engines/errors.js";
import { generation_request } from "./engines/contracts.js";
import { hash } from "./inference/contracts.js";
import { create_app } from "./app.js";
const token = "a".repeat(64);
const descriptor = (ready = true) => ({
  material: material_view(
    {
      id: "tree",
      name: "Tree",
      category: "vegetation/tree",
      tags: ["tree"],
      description: "A leafy tree",
      construction: ready
        ? {
            ...empty_material_construction(),
            kind: "model",
            placement: "ground",
            meters_per_unit: 1,
            dimensions_m: [1, 3, 1],
            footprint_m: [1, 1],
            up_axis: "y",
            forward_axis: "z",
            ground_anchor_m: [0, 0, 0],
          }
        : empty_material_construction(),
    },
    "b".repeat(64),
  ),
  runtime: {
    id: "tree",
    model: "tree.glb",
    format: "glb",
    resources: ["tree.glb"],
  },
});
const sample = () => ({
  contract_version: 1,
  brief: "Scatter five trees outside a two meter wide walking path.",
  document: create_component_document(randomUUID(), "Wooded path"),
});
const output = (
  actions = [
    {
      type: "scatter",
      material: "m1",
      seed: 1,
      count: 5,
      bounds: [-10, -10, 10, 10],
      exclusions: [[-1, -10, 1, 10]],
      scale_range: [1, 1],
    },
  ],
) => ({
  summary: "Proposed five trees around an open corridor.",
  questions: [],
  assumptions: ["The area is 20 by 20 meters."],
  actions,
});
async function fixture(t, options = {}) {
  const jobs = [],
    calls = [],
    reads = [];
  let writes = 0;
  const tree = options.tree || descriptor();
  const catalog = options.catalog || {
    async search(q) {
      reads.push(["search", q]);
      return { materials: [tree.material], total: 1, snapshot: "c".repeat(64) };
    },
    async resolve(ref) {
      reads.push(["resolve", ref]);
      return tree;
    },
  };
  const planner = create_construction_planner({ catalog });
  const service = new InferenceService({
    store: {
      token,
      all: () => jobs,
      maintain() {},
      close() {},
      free_bytes: () => 10 * 1024 ** 3,
      artifact() {
        writes++;
      },
      insert() {
        writes++;
      },
      save() {
        writes++;
      },
    },
    adapter: {
      ...(options.model_session
        ? { with_model_session: options.model_session }
        : {}),
      generate: async (request) => {
        generation_request(request);
        calls.push(request);
        if (options.generate) return options.generate(request, calls.length);
        return {
          structured:
            calls.length % 2
              ? { queries: ["tree"], recipe: "wooded-path-v1" }
              : options.output || output(),
          finish_reason: "stop",
          thinking: "private-provider-data",
        };
      },
    },
    construction_planner: planner,
    free_memory: () => 16 * 1024 ** 3,
    poll_ms: 60000,
  });
  const server = create_app({ inference: service }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await service.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    service,
    calls,
    reads,
    jobs,
    tree,
    get writes() {
      return writes;
    },
    request: (body = sample(), headers = {}, suffix = "") =>
      fetch(
        `http://127.0.0.1:${server.address().port}/inference/construction/plan${suffix}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Fracto-AI-Token": token,
            ...headers,
          },
          body: typeof body === "string" ? body : JSON.stringify(body),
        },
      ),
  };
}
test("planner returns pinned validated commands and bound previews without writing records", async (t) => {
  const f = await fixture(t),
    body = sample(),
    original = structuredClone(body);
  const response = await f.request(body);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const plan = await response.json();
  assert.equal(plan.status, "proposal");
  assert.equal(plan.applied, false);
  assert.equal(plan.planner_version, "construction-planner-v1");
  assert.equal(typeof plan.timings_ms.total, "number");
  assert.equal(typeof plan.timings_ms.retrieval.elapsed_ms, "number");
  assert.equal(typeof plan.timings_ms.construction.elapsed_ms, "number");
  assert.equal(plan.timings_ms.retrieval.load_ms, null);
  assert.equal(
    plan.base.document_hash,
    hash(component_document_json(body.document)),
  );
  assert.equal(plan.preview.total_instances, 5);
  assert.equal(plan.commands[0].rule.algorithm, "footprint-xz-v1");
  const preview = apply_component_commands(body.document, plan.commands, {
    [component_reference_key(f.tree.material)]: f.tree,
  });
  assert.equal(
    hash(component_document_json(preview)),
    plan.preview.document_hash,
  );
  assert.deepEqual(body, original);
  assert.equal(f.writes, 0);
  assert.equal(f.calls.length, 2);
  assert.equal(f.reads.filter(([kind]) => kind === "resolve").length, 2);
  assert.ok(!JSON.stringify(plan).includes("private-provider-data"));
  assert.equal(f.service.chat_active, null);
});
test("explicit construction guidance reaches both bounded prompts beneath the current brief", async (t) => {
  const f = await fixture(t),
    body = sample();
  body.guidance = [
    { kind: "preference", instructions: "Prefer sparse trees." },
    { kind: "recipe", instructions: "Keep a 2 meter walking corridor clear." },
  ];
  const response = await f.request(body);
  assert.equal(response.status, 200);
  assert.equal(f.calls.length, 2);
  for (const request of f.calls) {
    assert.match(
      request.messages[0].content,
      /current brief overrides remembered guidance/,
    );
    assert.deepEqual(
      JSON.parse(request.messages[1].content).remembered_guidance,
      body.guidance,
    );
    assert.ok(Buffer.byteLength(JSON.stringify(request.messages)) <= 7800);
  }
  assert.equal(f.writes, 0);
});
test("planner rejects identity/profile metadata and unbounded memory before generation", async (t) => {
  const f = await fixture(t);
  for (const guidance of [
    [{ kind: "preference", instructions: "Clear paths", user_id: "excluded" }],
    [{ kind: "recipe", instructions: "A path", id: randomUUID() }],
    Array.from({ length: 4 }, () => ({
      kind: "preference",
      instructions: "A rule",
    })),
    [{ kind: "preference", instructions: " " }],
    [{ kind: "recipe", instructions: "x".repeat(1001) }],
  ])
    assert.equal((await f.request({ ...sample(), guidance })).status, 400);
  assert.equal(f.calls.length, 0);
});
test("missing calibration is reported and model cannot invent catalog aliases or metadata", async (t) => {
  const f = await fixture(t, {
    tree: descriptor(false),
    output: {
      ...output([]),
      questions: ["Please calibrate the tree material."],
    },
  });
  const response = await f.request();
  const plan = await response.json();
  assert.equal(response.status, 200);
  assert.equal(plan.status, "needs_information");
  assert.deepEqual(plan.commands, []);
  assert.equal(plan.information_needed[0].reason, "calibration_required");
  assert.ok(
    plan.catalog_matches[0].missing_metadata.includes("meters_per_unit"),
  );
  const invalid = await fixture(t, {
    output: output([
      {
        type: "place",
        material: "invented-tree",
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
    ]),
  });
  assert.equal((await invalid.request()).status, 502);
  assert.equal(invalid.writes, 0);
});
test("geometric impossibilities and extra action fields reject the entire proposal", async (t) => {
  for (const actions of [
    [
      {
        type: "scatter",
        material: "m1",
        seed: 1,
        count: 5,
        bounds: [-1, -1, 1, 1],
        exclusions: [[-1, -1, 1, 1]],
        scale_range: [1, 1],
      },
    ],
    [
      {
        type: "place",
        material: "m1",
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        url: "http://untrusted.invalid",
      },
    ],
    [{ type: "remove", target: "none" }],
  ]) {
    const f = await fixture(t, { output: output(actions) });
    const response = await f.request();
    assert.equal(response.status, 502);
    assert.equal(f.writes, 0);
  }
});
test("a changed catalog revision after generation fails without returning commands", async (t) => {
  let reads = 0;
  const tree = descriptor();
  const f = await fixture(t, {
    catalog: {
      async search() {
        return { materials: [tree.material], total: 1 };
      },
      async resolve() {
        if (++reads > 1) {
          const { fail } = await import("./inference/contracts.js");
          fail("CONSTRUCTION_CATALOG_CHANGED", 409);
        }
        return tree;
      },
    },
  });
  const response = await f.request();
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "CONSTRUCTION_CATALOG_CHANGED",
  });
  assert.equal(f.writes, 0);
});
test("machine authentication precedes parsing and requests cannot override planner/model/provider", async (t) => {
  const f = await fixture(t);
  for (const headers of [
    { "X-Fracto-AI-Token": "" },
    { cookie: "private-session" },
    { origin: "http://localhost:3106" },
  ])
    assert.equal((await f.request("invalid json", headers)).status, 401);
  for (const extra of [
    { model: "override" },
    { catalog_url: "http://untrusted.invalid" },
    { recipes: ["execute code"] },
    { account_id: "excluded" },
  ])
    assert.equal((await f.request({ ...sample(), ...extra })).status, 400);
  assert.equal((await f.request(sample(), {}, "?override=yes")).status, 400);
  assert.equal(f.calls.length, 0);
  assert.throws(
    () => construction_request({ ...sample(), brief: " " }),
    /CONSTRUCTION_INVALID_REQUEST/,
  );
});
test("planner shares chat/job admission and cancellation frees the slot with no late output", async (t) => {
  let entered;
  const started = new Promise((resolve) => (entered = resolve));
  const f = await fixture(t, {
    generate: (request) =>
      new Promise((resolve, reject) => {
        entered();
        request.signal.addEventListener(
          "abort",
          () => reject(new EngineError("CANCELLED")),
          { once: true },
        );
      }),
  });
  const controller = new AbortController();
  const pending = f.service.construction_plan(sample(), {
    signal: controller.signal,
  });
  await started;
  await assert.rejects(
    f.service.chat({
      contract_version: 1,
      messages: [{ role: "user", content: "Hello" }],
    }),
    (error) => error.code === "ENGINE_BUSY",
  );
  await assert.rejects(
    f.service.construction_plan(sample()),
    (error) => error.code === "ENGINE_BUSY",
  );
  controller.abort();
  await assert.rejects(pending, (error) => error.code === "CANCELLED");
  assert.equal(f.service.chat_active, null);
  assert.equal(f.writes, 0);
  f.jobs.push({ state: "queued" });
  await assert.rejects(
    f.service.construction_plan(sample()),
    (error) => error.code === "ENGINE_BUSY",
  );
});
test("plain floor planning needs no catalog reads and preserves exact requested dimensions", async (t) => {
  const f = await fixture(t, {
    generate: async (request, number) => ({
      finish_reason: "stop",
      structured:
        number === 1
          ? { queries: [], recipe: "none" }
          : output([{ type: "floor", material: "none", size: [4, 12] }]),
    }),
  });
  const body = sample();
  body.brief = "A plain 4 by 12 meter floor.";
  const response = await f.request(body);
  assert.equal(response.status, 200);
  const plan = await response.json();
  assert.equal(plan.commands.length, 1);
  assert.equal(plan.commands[0].floor.asset, null);
  assert.deepEqual(plan.commands[0].floor.size, [4, 12]);
  assert.equal(plan.preview.floor, true);
  assert.equal(plan.preview.total_instances, 0);
  assert.deepEqual(f.reads, []);
  const alternatives = f.calls[1].schema.properties.actions.items.oneOf;
  assert.deepEqual(
    alternatives.map((item) => item.properties.type.const),
    ["floor"],
  );
  const action = alternatives[0];
  assert.deepEqual(Object.keys(action.properties).sort(), [
    "material",
    "repeat",
    "size",
    "type",
  ]);
  assert.ok(Buffer.byteLength(JSON.stringify(f.calls[1].messages)) < 2200);
  assert.match(
    f.calls[1].messages[0].content,
    /compact JSON without indentation/,
  );
  assert.equal(f.writes, 0);
});
test("construction admission stays reserved through model-session cleanup", async (t) => {
  let entered,
    release,
    leases = 0;
  const cleaning = new Promise((resolve) => (entered = resolve)),
    gate = new Promise((resolve) => (release = resolve));
  const f = await fixture(t, {
    model_session: async (execute) => {
      leases++;
      const result = await execute();
      entered();
      await gate;
      return result;
    },
  });
  const pending = f.service.construction_plan(sample());
  await cleaning;
  await assert.rejects(
    f.service.construction_plan(sample()),
    (error) => error.code === "ENGINE_BUSY",
  );
  release();
  const result = await pending;
  assert.equal(result.applied, false);
  assert.equal(leases, 1);
  assert.equal(f.service.chat_active, null);
});
test("planner deadlines release admission without returning partial commands", async (t) => {
  const f = await fixture(t, {
    generate: (request) =>
      new Promise((resolve, reject) => {
        request.signal.addEventListener(
          "abort",
          () => reject(new EngineError("CANCELLED")),
          { once: true },
        );
      }),
  });
  await assert.rejects(
    f.service.construction_plan(sample(), { timeout_ms: 25 }),
    (error) => error.code === "DEADLINE_EXCEEDED" && error.status === 504,
  );
  assert.equal(f.service.chat_active, null);
  assert.equal(f.writes, 0);
});
test("catalog client uses only loopback GETs and strips non-construction metadata", async () => {
  const tree = descriptor(),
    calls = [];
  const catalog = create_construction_catalog({
    environment: { FRACTO_ASSET_PORT: "32123" },
    request: async (url, options) => {
      calls.push({ url, options });
      const material = {
        ...tree.material,
        original_location: "private-field",
        account_id: "private-field",
      };
      return new Response(
        JSON.stringify(
          url.includes("materials/search")
            ? {
                contract_version: 1,
                materials: [material],
                total: 1,
                snapshot: "c".repeat(64),
              }
            : {
                material,
                runtime: { ...tree.runtime, account: "private-field" },
              },
        ),
        { headers: { "Content-Type": "application/json" } },
      );
    },
  });
  const signal = AbortSignal.timeout(1000);
  const page = await catalog.search("tree", signal);
  const resolved = await catalog.resolve(page.materials[0], signal);
  assert.ok(!JSON.stringify(resolved).includes("private-field"));
  assert.ok(
    calls.every(
      ({ url, options }) =>
        url.startsWith("http://127.0.0.1:32123/environment-catalog/") &&
        options.method === "GET" &&
        options.redirect === "manual" &&
        options.headers.cookie === undefined &&
        options.headers.origin === undefined,
    ),
  );
});
