import fs from "node:fs";
import path from "node:path";
import { KnowledgeStore } from "./storage.js";
import { seed_infrastructure } from "../infrastructure/seed.js";

export const knowledge_directory = (environment = process.env) => {
  if (
    fs.existsSync("/.dockerenv") &&
    !environment.FRACTO_AI_DATA_DIR &&
    !environment.FRACTO_AI_KNOWLEDGE_DIR
  )
    throw new Error("KNOWLEDGE_CONFIGURATION_ERROR");
  return (
    environment.FRACTO_AI_KNOWLEDGE_DIR ||
    (environment.FRACTO_AI_DATA_DIR
      ? path.join(environment.FRACTO_AI_DATA_DIR, "knowledge")
      : path.join(import.meta.dirname, "../runtime/knowledge"))
  );
};
export const create_knowledge_runtime = (environment = process.env) => {
  try {
    const store = new KnowledgeStore(knowledge_directory(environment));
    try {
      seed_infrastructure(store);
    } catch {
      console.error(
        "fracto-ai-server infrastructure reference seed unavailable",
      );
    }
    return store;
  } catch {
    console.error(
      "fracto-ai-server knowledge unavailable: local initialization failed",
    );
    return null;
  }
};
