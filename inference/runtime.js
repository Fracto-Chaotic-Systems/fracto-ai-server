import path from "node:path";
import { create_engine_adapter } from "../engines/registry.js";
import { LocalStore } from "./storage.js";
import { InferenceService } from "./service.js";
import { create_app_chat_reference } from "../app_reference/chat.js";

const headroom = (environment, key, fallback, maximum) => {
  const raw = environment[key] ?? String(fallback);
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > maximum)
    throw new Error("Invalid admission configuration");
  return Number(raw) * 1024 ** 2;
};
export const create_inference_runtime = (environment = process.env) => {
  let store;
  try {
    const adapter = create_engine_adapter({
      engine: environment.FRACTO_AI_ENGINE || "ollama",
      model: environment.FRACTO_AI_MODEL || null,
      base_url: environment.FRACTO_OLLAMA_URL || "http://127.0.0.1:11434",
      allow_host_gateway:
        environment.FRACTO_OLLAMA_ALLOW_HOST_GATEWAY === "true",
    });
    const min_memory_bytes = headroom(
      environment,
      "FRACTO_AI_MIN_FREE_MEMORY_MIB",
      6144,
      1048576,
    );
    const min_disk_bytes = headroom(
      environment,
      "FRACTO_AI_MIN_FREE_DISK_MIB",
      1024,
      1048576,
    );
    store = new LocalStore(
      environment.FRACTO_AI_DATA_DIR ||
        path.join(import.meta.dirname, "../runtime/inference"),
      { token: environment.FRACTO_AI_INFERENCE_TOKEN || undefined },
    );
    const service = new InferenceService({
      store,
      adapter,
      min_memory_bytes,
      min_disk_bytes,
      app_reference: create_app_chat_reference(environment),
    });
    return { service, engine_status: () => adapter.status() };
  } catch {
    store?.close();
    // Deliberately no in-memory fallback, secret, path or platform error detail.
    console.error(
      "fracto-ai-server inference unavailable: local initialization failed",
    );
    return { service: null };
  }
};
