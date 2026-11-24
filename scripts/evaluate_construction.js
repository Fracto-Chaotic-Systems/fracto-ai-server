import fs from "node:fs/promises";
import path from "node:path";
import { create_construction_catalog } from "../construction/catalog.js";
import { create_local_construction_client } from "../construction/client.js";
import { run_scripted_build_evaluation } from "../construction/evaluation.js";
import { run_live_build_evaluation } from "../construction/live_evaluation.js";
import { run_live_dense_grass } from "../construction/dense_grass_evaluation.js";

async function main() {
  const args = process.argv.slice(2);
  if (
    args.some(
      (arg) =>
        ![
          "--live",
          "--catalog",
          "--write",
          "--summary",
          "--plain-floor",
          "--wooded-path",
          "--grass-strip",
        ].includes(arg),
    )
  )
    throw new Error("CONSTRUCTION_EVALUATION_INPUT");
  if (
    ((args.includes("--plain-floor") ||
      args.includes("--wooded-path") ||
      args.includes("--grass-strip")) &&
      !args.includes("--live")) ||
    args.filter((arg) =>
      ["--plain-floor", "--wooded-path", "--grass-strip"].includes(arg),
    ).length > 1
  )
    throw new Error("CONSTRUCTION_EVALUATION_INPUT");
  const report = {
    contract_version: 1,
    started_at: new Date().toISOString(),
    mode: args.includes("--live")
      ? "live_read_only"
      : args.includes("--catalog")
        ? "catalog_read_only"
        : "offline",
    scripted: await run_scripted_build_evaluation(),
    catalog: [],
    live: [],
    memory_benefit: "not_measured",
  };
  const catalog =
    args.includes("--live") || args.includes("--catalog")
      ? create_construction_catalog()
      : null;
  if (args.includes("--live") || args.includes("--catalog"))
    for (const query of ["dirt", "grass", "shrub", "tree"]) {
      try {
        const page = await catalog.search(query, AbortSignal.timeout(20000));
        report.catalog.push({
          query,
          total_matches: page.total,
          sampled: page.materials.length,
          ready: page.materials.filter((item) => item.placement_ready).length,
          materials: page.materials.map(
            ({ id, placement_ready, missing_metadata }) => ({
              id,
              placement_ready,
              missing_metadata,
            }),
          ),
        });
      } catch (error) {
        report.catalog.push({
          query,
          error: /^[A-Z_]+$/.test(error.message)
            ? error.message
            : "CATALOG_UNAVAILABLE",
        });
      }
    }
  if (args.includes("--live")) {
    const result = await (
      args.includes("--grass-strip")
        ? run_live_dense_grass
        : run_live_build_evaluation
    )({
      plan: await create_local_construction_client(),
      catalog,
      audit: report.catalog,
      plain_floor_only: args.includes("--plain-floor"),
      wooded_path_only: args.includes("--wooded-path"),
      wooded_surface: args.includes("--wooded-path")
        ? { id: "dry-dirt", name: "dry_dirt" }
        : null,
      on_case: (id) =>
        console.error(
          `Evaluating configured local model: ${id} (175-second server deadline)`,
        ),
    });
    report.live = result.cases;
    report.memory_benefit = result.memory_benefit;
  }
  report.finished_at = new Date().toISOString();
  if (args.includes("--write")) {
    const directory = path.join(import.meta.dirname, "../runtime");
    await fs.mkdir(directory, { recursive: true });
    const filename =
      report.mode === "live_read_only"
        ? args.includes("--grass-strip")
          ? "construction-evaluation-grass-strip.json"
          : args.includes("--wooded-path")
            ? "construction-evaluation-wooded-path.json"
            : args.includes("--plain-floor")
              ? "construction-evaluation-plain-floor.json"
              : "construction-evaluation.json"
        : report.mode === "catalog_read_only"
          ? "construction-evaluation-catalog.json"
          : "construction-evaluation-offline.json";
    await fs.writeFile(
      path.join(directory, filename),
      JSON.stringify(report, null, 2) + "\n",
    );
  }
  console.log(
    JSON.stringify(
      args.includes("--summary")
        ? {
            mode: report.mode,
            scripted_cases: report.scripted.cases.length,
            scripted_harness_pass: report.scripted.cases.every(
              (item) => item.harness_pass,
            ),
            fault_cases: report.scripted.faults.length,
            faults_pass: report.scripted.faults.every((item) => item.passed),
            catalog: report.catalog.map(
              ({ query, total_matches, ready, error }) => ({
                query,
                total_matches,
                ready,
                error,
              }),
            ),
            live: report.live.map(
              ({
                case: id,
                outcome,
                elapsed_ms,
                error,
                reason,
                comparison_only,
                planner_timings_ms,
              }) => ({
                case: id,
                outcome,
                elapsed_ms,
                error,
                reason,
                comparison_only,
                planner_timings_ms,
              }),
            ),
            memory_benefit: report.memory_benefit,
          }
        : report,
      null,
      2,
    ),
  );
  if (
    report.scripted.cases.some((item) => !item.harness_pass) ||
    report.scripted.faults.some((item) => !item.passed) ||
    report.live.some((item) => item.outcome === "fail" && !item.comparison_only)
  )
    process.exitCode = 1;
}
main().catch(() => {
  console.error("CONSTRUCTION_EVALUATION_UNAVAILABLE");
  process.exitCode = 1;
});
