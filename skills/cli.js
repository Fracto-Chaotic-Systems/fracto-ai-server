import fs from "node:fs";
import { KnowledgeStore } from "../knowledge/storage.js";
import { knowledge_directory } from "../knowledge/runtime.js";
import { SkillRegistry } from "./storage.js";
import { skill_directory } from "./runtime.js";
import { SkillError, fail } from "./contracts.js";
import { executor_digest, run_active } from "./executor.js";
import { evaluate_release } from "./evaluate.js";

const read_json = (file, limit = 32768) => {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit)
    fail("INVALID_SKILL_FILE");
  const bytes = fs.readFileSync(file);
  if (bytes.length > limit) fail("INVALID_SKILL_FILE");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
};
let registry, reader;
try {
  const [command, ...args] = process.argv.slice(2);
  const counts = {
    list: [0, 1],
    versions: [1, 2],
    get: [2],
    publish: [1],
    evaluate: [2],
    activate: [3],
    deactivate: [2],
    history: [0],
    run: [2],
  };
  if (!Object.hasOwn(counts, command) || !counts[command].includes(args.length))
    fail("INVALID_SKILL_COMMAND");
  registry = new SkillRegistry(skill_directory(), {
    read_only: !["publish", "evaluate", "activate", "deactivate"].includes(
      command,
    ),
  });
  let result;
  if (command === "list") result = registry.list(args[0] ?? "");
  if (command === "versions")
    result = registry.versions(args[0], args[1] ?? "");
  if (command === "get") result = registry.get(...args);
  if (command === "publish") result = registry.publish(read_json(args[0]));
  if (command === "evaluate") result = evaluate_release(registry, ...args);
  if (command === "activate")
    result = registry.select(
      args[0],
      args[1],
      args[2] === "none" ? null : args[2],
      executor_digest(),
    );
  if (command === "deactivate")
    result = registry.select(
      args[0],
      null,
      args[1] === "none" ? null : args[1],
      executor_digest(),
    );
  if (command === "history") result = registry.history();
  if (command === "run") {
    if (["infrastructure-reference", "app-reference"].includes(args[0]))
      reader = new KnowledgeStore(knowledge_directory(), { read_only: true });
    result = run_active(
      registry,
      args[0],
      read_json(
        args[1],
        args[0] === "environment-asset-quality" ? 8 * 1024 ** 2 : 32768,
      ),
      reader,
    );
  }
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(
    JSON.stringify({
      error:
        error instanceof SkillError ? error.code : "SKILL_REGISTRY_UNAVAILABLE",
    }),
  );
  process.exitCode = 1;
} finally {
  reader?.close();
  registry?.close();
}
