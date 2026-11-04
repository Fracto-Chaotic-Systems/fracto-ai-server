import { ENGINE_IDS } from "./contracts.js";
import { EngineError } from "./errors.js";
import { OllamaAdapter } from "./ollama.js";

export const ENGINE_IMPLEMENTATIONS = Object.freeze(
  Object.fromEntries(
    ENGINE_IDS.map((id) => [
      id,
      id === "ollama" ? "implemented" : "unavailable",
    ]),
  ),
);
class UnavailableAdapter {
  constructor(id) {
    this.id = id;
  }
  async status() {
    return {
      engine: this.id,
      state: "adapter_unavailable",
      adapter_implemented: false,
      adapter_features: {
        generation: false,
        json_schema: false,
        streaming: false,
        cancellation: false,
        cancellation_scope: "none",
        embeddings: false,
        warmup: false,
      },
      engine_version: null,
      model_count: null,
      model_configured: false,
      model_present: false,
      model_loaded: false,
      active_requests: 0,
      concurrency_limit: 0,
      error: "NOT_IMPLEMENTED",
    };
  }
  async health() {
    throw new EngineError("NOT_IMPLEMENTED");
  }
  async list_models() {
    throw new EngineError("NOT_IMPLEMENTED");
  }
  async generate() {
    throw new EngineError("NOT_IMPLEMENTED");
  }
  async warmup() {
    throw new EngineError("NOT_IMPLEMENTED");
  }
  async embed() {
    throw new EngineError("NOT_IMPLEMENTED");
  }
  async stream() {
    throw new EngineError("NOT_IMPLEMENTED");
  }
}
export const create_engine_adapter = ({
  engine = "ollama",
  ...configuration
} = {}) => {
  if (!ENGINE_IDS.includes(engine))
    throw new EngineError("CONFIGURATION_ERROR");
  return engine === "ollama"
    ? new OllamaAdapter(configuration)
    : new UnavailableAdapter(engine);
};

/** Environment-owned configuration only; route parameters never select a URL. */
export const create_engine_status_reader = (environment = process.env) => {
  let adapter;
  try {
    adapter = create_engine_adapter({
      engine: environment.FRACTO_AI_ENGINE || "ollama",
      base_url: environment.FRACTO_OLLAMA_URL || "http://127.0.0.1:11434",
      model: environment.FRACTO_AI_MODEL || null,
      allow_host_gateway:
        environment.FRACTO_OLLAMA_ALLOW_HOST_GATEWAY === "true",
    });
  } catch {
    return async () => ({
      contract_version: 1,
      state: "configuration_error",
      engine: null,
      available_engines: { ...ENGINE_IMPLEMENTATIONS },
      error: "CONFIGURATION_ERROR",
    });
  }
  return async () => ({
    contract_version: 1,
    available_engines: { ...ENGINE_IMPLEMENTATIONS },
    ...(await adapter.status()),
  });
};
