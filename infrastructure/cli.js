import { KnowledgeStore, KnowledgeError } from "../knowledge/storage.js";
import { knowledge_directory } from "../knowledge/runtime.js";
import { question_terms } from "./reference.js";
import { SkillRegistry } from "../skills/storage.js";
import { skill_directory } from "../skills/runtime.js";
import { SkillError } from "../skills/contracts.js";
import { run_active } from "../skills/executor.js";

let reader;
let registry;
try {
  const [command, question, ...extra] = process.argv.slice(2);
  if (command !== "ask" || extra.length)
    throw new KnowledgeError("INVALID_COMMAND");
  question_terms(question);
  reader = new KnowledgeStore(knowledge_directory(), { read_only: true });
  registry = new SkillRegistry(skill_directory(), { read_only: true });
  console.log(
    JSON.stringify(
      run_active(registry, "infrastructure-reference", { question }, reader),
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      error:
        error instanceof KnowledgeError || error instanceof SkillError
          ? error.code
          : "KNOWLEDGE_UNAVAILABLE",
    }),
  );
  process.exitCode = 1;
} finally {
  reader?.close();
  registry?.close();
}
