import fs from "node:fs";
import path from "node:path";
import { SkillRegistry } from "./storage.js";
import { infrastructure_definition } from "./builtin.js";
import { data_quality_definition } from "../data_quality/builtin.js";
import { executor_digest } from "./executor.js";
import { evaluate_release } from "./evaluate.js";

export const skill_directory = (environment = process.env) => {
  if (
    fs.existsSync("/.dockerenv") &&
    !environment.FRACTO_AI_DATA_DIR &&
    !environment.FRACTO_AI_SKILL_DIR
  )
    throw new Error("SKILL_CONFIGURATION_ERROR");
  return (
    environment.FRACTO_AI_SKILL_DIR ||
    (environment.FRACTO_AI_DATA_DIR
      ? path.join(environment.FRACTO_AI_DATA_DIR, "skills")
      : path.join(import.meta.dirname, "../runtime/skills"))
  );
};
export const create_skill_runtime = (environment = process.env) => {
  let registry;
  try {
    registry = new SkillRegistry(skill_directory(environment));
    for (const definition of [
      infrastructure_definition,
      data_quality_definition,
    ]) {
      const release = registry.publish(definition);
      if (
        !release.evaluation ||
        release.evaluation.executor_digest !== executor_digest() ||
        release.evaluation.definition_digest !== release.digest
      )
        evaluate_release(registry, release.id, release.version);
      registry.select(release.id, release.version, null, executor_digest(), {
        bootstrap: true,
      });
    }
    return registry;
  } catch {
    registry?.close();
    console.error(
      "fracto-ai-server skill registry unavailable: local initialization failed",
    );
    return null;
  }
};
