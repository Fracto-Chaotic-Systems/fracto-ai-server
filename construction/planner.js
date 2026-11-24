import { randomUUID } from "node:crypto";
import { component_document_json } from "@fracto/sdk/FractoComponentDocument.js";
import {
  apply_component_commands,
  component_reference_key,
  require_component_material,
} from "@fracto/sdk/FractoComponentTools.js";
import { validate_material_query } from "@fracto/sdk/FractoMaterialSearch.js";
import { fail, hash } from "../inference/contracts.js";
import {
  construction_request,
  PLANNER_VERSION,
  search_schema,
  action_schema,
  checked_output,
} from "./contracts.js";
import { scene_context, search_messages, plan_context } from "./prompts.js";
import { translate_actions } from "./translate.js";
import { create_construction_catalog } from "./catalog.js";
import {
  wooded_path_bindings,
  wooded_path_schema,
  wooded_path_messages,
} from "./wooded_path_contract.js";
import { compile_wooded_path } from "./wooded_path.js";
import {
  dense_grass_bindings,
  dense_grass_messages,
  dense_grass_schema,
  compile_dense_grass,
  dense_grass_queries,
} from "./dense_grass_strip.js";

// Preserve distinct requested materials before filling the bounded context with
// alternatives from a prolific query (e.g. four grasses must not crowd out dirt).
export function select_ready_materials(pages, limit = 8) {
  const selected = new Map();
  const rows = pages.map((page) =>
    page.materials.filter((item) => item.placement_ready),
  );
  for (
    let rank = 0;
    rows.some((row) => row.length > rank) && selected.size < limit;
    rank++
  ) {
    for (const row of rows) {
      const material = row[rank];
      if (material && !selected.has(material.id))
        selected.set(material.id, material);
      if (selected.size === limit) break;
    }
  }
  return [...selected.values()];
}

export function create_construction_planner({
  catalog = create_construction_catalog(),
} = {}) {
  return async (body, { generate, signal }) => {
    const request = construction_request(body),
      scene = scene_context(request.document),
      start = Date.now();
    const timings_ms = {};
    const metric = (value) =>
      Number.isFinite(value) && value >= 0 ? value : null;
    const generate_checked = async (phase, messages, schema, max_tokens) => {
      signal.throwIfAborted();
      const phase_start = Date.now();
      const result = await generate({
        messages,
        schema,
        max_tokens,
        temperature: 0,
        signal,
        timeout_ms: Math.max(1, 170000 - (Date.now() - start)),
      });
      signal.throwIfAborted();
      timings_ms[phase] = {
        elapsed_ms: Date.now() - phase_start,
        load_ms: metric(result.timings_ms?.load),
        input_ms: metric(result.timings_ms?.input),
        output_ms: metric(result.timings_ms?.output),
        input_tokens: metric(result.usage?.input_tokens),
        output_tokens: metric(result.usage?.output_tokens),
      };
      return checked_output(result, schema);
    };
    const retrieval = await generate_checked(
      "retrieval",
      search_messages(request, scene),
      search_schema,
      256,
    );
    let queries;
    try {
      queries = [
        ...new Set(
          retrieval.queries.map(
            (q) => validate_material_query({ q, limit: 4 }).q,
          ),
        ),
      ];
      if (queries.some((q) => !q)) throw new Error();
      if (retrieval.recipe === "dense-grass-strip-v1")
        queries = [...dense_grass_queries];
    } catch {
      fail("CONSTRUCTION_INVALID_OUTPUT", 502);
    }
    const pages = await Promise.all(
      queries.map(async (query) => ({
        query,
        ...(await catalog.search(query, signal)),
      })),
    );
    signal.throwIfAborted();
    const found = new Map();
    for (const page of pages)
      for (const material of page.materials) {
        if (
          found.has(material.id) &&
          found.get(material.id).revision !== material.revision
        )
          fail("CONSTRUCTION_CATALOG_CHANGED", 409);
        found.set(material.id, material);
      }
    const candidates = [...found.values()],
      ready = select_ready_materials(pages, Math.min(8, pages.length)),
      descriptors = [];
    for (let i = 0; i < ready.length; i += 4)
      descriptors.push(
        ...(await Promise.all(
          ready
            .slice(i, i + 4)
            .map((material) => catalog.resolve(material, signal)),
        )),
      );
    const usable = descriptors.filter(
      ({ material, runtime }) =>
        material.placement_ready &&
        (material.construction.kind === "model"
          ? runtime.model &&
            ["glb", "gltf", "fbx", "obj", "3ds"].includes(runtime.format)
          : material.construction.placement === "floor" &&
            runtime.resources.some((file) =>
              /\.(png|jpe?g|webp)$/i.test(file),
            )),
    );
    const context = plan_context(
      request,
      scene,
      retrieval.recipe,
      usable,
      candidates.filter((material) => !material.placement_ready),
    );
    const bindings = wooded_path_bindings(
      retrieval.recipe,
      request.document,
      context.materials,
    );
    const dense = dense_grass_bindings(
      retrieval.recipe,
      request.document,
      context.materials,
    );
    const output = dense
      ? compile_dense_grass(
          await generate_checked(
            "construction",
            dense_grass_messages(request),
            dense_grass_schema,
            256,
          ),
          dense,
          context.materials,
        )
      : bindings
        ? compile_wooded_path(
            await generate_checked(
              "construction",
              wooded_path_messages(request, bindings, context.materials),
              wooded_path_schema,
              512,
            ),
            bindings,
            context.materials,
          )
        : await generate_checked(
            "construction",
            context.messages,
            action_schema(context.materials, scene.targets, {
              has_floor: !!request.document.floor,
            }),
            1024,
          );
    const translated = translate_actions(
        output.actions,
        context.materials,
        scene.targets,
      ),
      materials = {};
    if (output.pattern) {
      translated.commands.push(output.pattern);
      translated.references.push(output.pattern.asset);
    }
    // Resolve again after model generation: never return an edit with a knowingly
    // replaced pin. Removal remains available for missing/unavailable objects.
    for (let i = 0; i < translated.references.length; i += 4)
      await Promise.all(
        translated.references.slice(i, i + 4).map(async (ref) => {
          materials[component_reference_key(ref)] = await catalog.resolve(
            ref,
            signal,
          );
        }),
      );
    signal.throwIfAborted();
    let preview;
    try {
      for (const command of translated.commands)
        if (command.type === "transform")
          require_component_material(
            request.document.objects.find((item) => item.id === command.id)
              .asset,
            materials,
            "model",
          );
      preview = translated.commands.length
        ? apply_component_commands(
            request.document,
            translated.commands,
            materials,
          )
        : request.document;
    } catch {
      fail("CONSTRUCTION_INVALID_PLAN", 502);
    }
    const chosen = new Set(
      Object.values(context.materials).map((entry) => entry.material.id),
    );
    const information_needed = pages
      .filter(
        (page) => !page.materials.some((material) => chosen.has(material.id)),
      )
      .map((page) => ({
        query: page.query,
        reason:
          page.total === 0
            ? "not_found"
            : page.materials.every((material) => !material.placement_ready)
              ? "calibration_required"
              : "no_usable_candidate",
        total_matches: page.total,
        material_ids: page.materials.map((material) => material.id),
      }));
    return {
      contract_version: 1,
      planner_version: PLANNER_VERSION,
      timings_ms: { ...timings_ms, total: Date.now() - start },
      proposal_id: randomUUID(),
      applied: false,
      base: {
        document_id: request.document.id,
        document_hash: hash(component_document_json(request.document)),
      },
      status:
        information_needed.length || output.questions.length
          ? "needs_information"
          : translated.commands.length
            ? "proposal"
            : "no_changes",
      recipe: retrieval.recipe,
      summary: output.summary,
      assumptions: output.assumptions,
      questions: output.questions,
      commands: translated.commands,
      information_needed,
      catalog_matches: candidates.map(
        ({
          id,
          revision,
          name,
          category,
          missing_metadata,
          placement_ready,
        }) => ({
          id,
          revision,
          name,
          category,
          missing_metadata,
          placement_ready,
        }),
      ),
      catalog_limited:
        context.limited ||
        candidates.filter((material) => material.placement_ready).length >
          ready.length ||
        pages.some((page) => page.total > page.materials.length),
      scene_limited: scene.limited,
      preview: {
        document_hash: hash(component_document_json(preview)),
        floor: !!preview.floor,
        objects: preview.objects.length,
        scatter_rules: preview.scatters.length,
        total_instances:
          preview.objects.length +
          preview.scatters.reduce((sum, rule) => sum + rule.count, 0),
      },
    };
  };
}
