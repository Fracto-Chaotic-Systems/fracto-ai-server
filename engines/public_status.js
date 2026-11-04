import { ENGINE_IDS } from "./contracts.js";
import { ENGINE_IMPLEMENTATIONS } from "./registry.js";

const states = new Set([
  "engine_unavailable",
  "model_missing",
  "ready",
  "warming",
  "busy",
  "adapter_unavailable",
  "configuration_error",
]);
const codes = new Set([
  "ENGINE_UNAVAILABLE",
  "MODEL_MISSING",
  "ENGINE_BUSY",
  "DEADLINE_EXCEEDED",
  "CANCELLED",
  "INVALID_REQUEST",
  "INVALID_OUTPUT",
  "UNSUPPORTED_OPERATION",
  "NOT_IMPLEMENTED",
  "PROTOCOL_ERROR",
  "CONFIGURATION_ERROR",
]);
/** Serialize a fixed contract even if a later adapter adds private metadata. */
export const public_engine_status = (value = {}) => {
  const features = value.adapter_features || {};
  return {
    contract_version: 1,
    available_engines: { ...ENGINE_IMPLEMENTATIONS },
    engine: ENGINE_IDS.includes(value.engine) ? value.engine : null,
    state: states.has(value.state) ? value.state : "engine_unavailable",
    adapter_implemented: value.adapter_implemented === true,
    adapter_features: {
      generation: features.generation === true,
      json_schema: features.json_schema === true,
      streaming: features.streaming === true,
      cancellation: features.cancellation === true,
      cancellation_scope:
        features.cancellation_scope === "request" ? "request" : "none",
      embeddings: features.embeddings === true,
      warmup: features.warmup === true,
    },
    engine_version:
      typeof value.engine_version === "string" &&
      /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(value.engine_version) &&
      value.engine_version.length <= 64
        ? value.engine_version.match(/^\d+\.\d+\.\d+/)[0]
        : null,
    model_count:
      Number.isInteger(value.model_count) &&
      value.model_count >= 0 &&
      value.model_count <= 1024
        ? value.model_count
        : null,
    model_configured: value.model_configured === true,
    model_present: value.model_present === true,
    model_loaded: value.model_loaded === true,
    active_requests: value.active_requests === 1 ? 1 : 0,
    concurrency_limit: value.concurrency_limit === 1 ? 1 : 0,
    error: codes.has(value.error) ? value.error : null,
  };
};
