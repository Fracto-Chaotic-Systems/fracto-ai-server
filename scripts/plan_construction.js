import fs from "node:fs/promises";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { create_component_document } from "@fracto/sdk/FractoComponentDocument.js";
import { construction_request } from "../construction/contracts.js";
import { create_local_construction_client } from "../construction/client.js";

// Local machine caller only. Reads the existing secret without initializing a
// second store, printing credentials, changing model selection or saving plans.
async function main() {
  const args = process.argv.slice(2),
    smoke = args.includes("--smoke"),
    summary = args.includes("--summary");
  const input_index = args.indexOf("--input");
  const allowed = new Set([
    "--smoke",
    "--summary",
    "--input",
    ...(input_index >= 0 ? [args[input_index + 1]] : []),
  ]);
  if (
    args.some((arg) => !allowed.has(arg)) ||
    (smoke && input_index >= 0) ||
    (!smoke && (input_index < 0 || !args[input_index + 1]))
  )
    throw new Error("CONSTRUCTION_CLI_INPUT");
  let body;
  if (smoke)
    body = {
      contract_version: 1,
      brief:
        "Propose only a plain neutral floor 4 meters wide and 12 meters deep. No textures, materials, or other objects are needed. Dimensions are explicit; no questions are needed.",
      document: create_component_document(randomUUID(), "Planner smoke test"),
    };
  else {
    const file = args[input_index + 1];
    if ((await fs.stat(file)).size > 1024 * 1024)
      throw new Error("CONSTRUCTION_CLI_INPUT");
    body = JSON.parse(await fs.readFile(file, "utf8"));
  }
  body = construction_request(body);
  const plan = await create_local_construction_client();
  const result = await plan(body);
  if (
    smoke &&
    (result.applied !== false ||
      result.commands.length !== 1 ||
      result.commands[0].type !== "set-floor" ||
      result.commands[0].floor.asset !== null ||
      JSON.stringify(result.commands[0].floor.size) !== "[4,12]")
  )
    throw new Error("CONSTRUCTION_SMOKE_MISMATCH");
  console.log(
    JSON.stringify(
      summary
        ? {
            planner_version: result.planner_version,
            status: result.status,
            applied: result.applied,
            timings_ms: {
              total: result.timings_ms?.total,
              retrieval: result.timings_ms?.retrieval?.elapsed_ms,
              construction: result.timings_ms?.construction?.elapsed_ms,
            },
            commands: result.commands.length,
            information_needed: result.information_needed.length,
            preview: {
              floor: result.preview.floor,
              objects: result.preview.objects,
              scatter_rules: result.preview.scatter_rules,
            },
          }
        : result,
      null,
      2,
    ),
  );
}
main().catch((error) => {
  console.error(
    /^[A-Z_]+$/.test(error.message)
      ? error.message
      : "CONSTRUCTION_CLI_UNAVAILABLE",
  );
  process.exitCode = 1;
});
