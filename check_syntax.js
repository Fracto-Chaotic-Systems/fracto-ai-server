import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const source = [
  import.meta.dirname,
  path.join(import.meta.dirname, "engines"),
  path.join(import.meta.dirname, "inference"),
  path.join(import.meta.dirname, "peers"),
  path.join(import.meta.dirname, "exchange"),
  path.join(import.meta.dirname, "delegation"),
  path.join(import.meta.dirname, "knowledge"),
  path.join(import.meta.dirname, "subject_providers"),
  path.join(import.meta.dirname, "infrastructure"),
  path.join(import.meta.dirname, "app_reference"),
  path.join(import.meta.dirname, "skills"),
  path.join(import.meta.dirname, "data_quality"),
  path.join(import.meta.dirname, "distribution"),
];
let checked = 0;
for (const directory of source) {
  for (const file of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!file.isFile() || !file.name.endsWith(".js")) continue;
    const result = spawnSync(
      process.execPath,
      ["--check", path.join(directory, file.name)],
      { stdio: "inherit" },
    );
    if (result.status !== 0) process.exit(result.status || 1);
    checked++;
  }
}
console.log(`Syntax check passed for ${checked} AI service JavaScript files`);
