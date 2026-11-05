import fs from "node:fs";
import { SkillRegistry } from "../skills/storage.js";
import { skill_directory } from "../skills/runtime.js";
import { SkillError, fail } from "../skills/contracts.js";
import { run_active } from "../skills/executor.js";
import { select_correction_request } from "./request.js";

let registry;
try {
  const [command, file, ...extra] = process.argv.slice(2);
  if (
    !file ||
    !(
      (command === "scan" && extra.length === 0) ||
      (command === "request" && extra.length === 1)
    )
  )
    fail("INVALID_SKILL_COMMAND");
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 ** 2)
    fail("INVALID_SKILL_FILE");
  const bytes = fs.readFileSync(file);
  if (bytes.length > 8 * 1024 ** 2) fail("INVALID_SKILL_FILE");
  const input = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  registry = new SkillRegistry(skill_directory(), { read_only: true });
  const report = run_active(registry, "environment-asset-quality", input);
  console.log(
    JSON.stringify(
      command === "request"
        ? select_correction_request(report, extra[0])
        : report,
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      error:
        error instanceof SkillError ? error.code : "DATA_QUALITY_UNAVAILABLE",
    }),
  );
  process.exitCode = 1;
} finally {
  registry?.close();
}
