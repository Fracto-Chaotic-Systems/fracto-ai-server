import Ajv from "ajv";
import { EngineError } from "./errors.js";

export const ENGINE_IDS = Object.freeze([
  "ollama",
  "llama_cpp",
  "vllm",
  "sglang",
]);
export const FEATURES = Object.freeze({
  generation: true,
  json_schema: true,
  streaming: false,
  cancellation: true,
  cancellation_scope: "request",
  embeddings: false,
  warmup: true,
});
const ajv = new Ajv({ strict: true, allErrors: false, addUsedSchema: false });
const keywords = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "title",
  "description",
  "$schema",
]);
export const plain_object = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);
export const exact_fields = (value, names) => {
  if (
    !plain_object(value) ||
    Object.keys(value).some((key) => !names.includes(key))
  )
    throw new EngineError("INVALID_REQUEST");
};
export const model_id = (value) => {
  if (
    typeof value !== "string" ||
    value.length > 160 ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*(?::[a-zA-Z0-9._-]+)?$/.test(value) ||
    /(?:-cloud|:cloud)$/i.test(value)
  )
    throw new EngineError("CONFIGURATION_ERROR");
  return value.includes(":") ? value : `${value}:latest`;
};
export const compile_schema = (schema) => {
  if (schema == null) return null;
  try {
    let values = 0;
    const json_value = (value, depth = 0) => {
      if (++values > 4096 || depth > 32) throw new Error();
      if (
        value === null ||
        typeof value === "string" ||
        typeof value === "boolean"
      )
        return;
      if (typeof value === "number" && Number.isFinite(value)) return;
      if (!Array.isArray(value) && !plain_object(value)) throw new Error();
      for (const child of Object.values(value)) json_value(child, depth + 1);
    };
    json_value(schema);
    const serialized = JSON.stringify(schema);
    if (!serialized || Buffer.byteLength(serialized) > 16384) throw new Error();
    // Snapshot plain JSON, excluding references, executable patterns and external formats.
    const copy = JSON.parse(serialized);
    let nodes = 0;
    const visit = (node, depth) => {
      if (++nodes > 512 || depth > 8 || !plain_object(node)) throw new Error();
      if (Object.keys(node).some((key) => !keywords.has(key)))
        throw new Error();
      if (
        node.$schema != null &&
        node.$schema !== "http://json-schema.org/draft-07/schema#"
      )
        throw new Error();
      if (node.properties != null) {
        if (!plain_object(node.properties)) throw new Error();
        for (const child of Object.values(node.properties))
          visit(child, depth + 1);
      }
      if (node.items != null) visit(node.items, depth + 1);
      if (plain_object(node.additionalProperties))
        visit(node.additionalProperties, depth + 1);
    };
    visit(copy, 0);
    const validate = ajv.compile(copy);
    ajv.removeSchema(copy);
    return { schema: copy, validate };
  } catch {
    throw new EngineError("INVALID_REQUEST");
  }
};
export const generation_request = (input) => {
  exact_fields(input, [
    "messages",
    "schema",
    "max_tokens",
    "temperature",
    "signal",
    "timeout_ms",
    "stream",
    "expected_model_digest",
  ]);
  if (input.stream !== undefined && input.stream !== false)
    throw new EngineError("UNSUPPORTED_OPERATION");
  if (
    !Array.isArray(input.messages) ||
    input.messages.length < 1 ||
    input.messages.length > 16
  )
    throw new EngineError("INVALID_REQUEST");
  const messages = input.messages.map((message) => {
    exact_fields(message, ["role", "content"]);
    if (
      !["system", "user", "assistant"].includes(message.role) ||
      typeof message.content !== "string"
    )
      throw new EngineError("INVALID_REQUEST");
    return { role: message.role, content: message.content };
  });
  if (Buffer.byteLength(JSON.stringify(messages)) > 8192)
    throw new EngineError("INVALID_REQUEST");
  const max_tokens = input.max_tokens ?? 512;
  const temperature = input.temperature ?? 0;
  if (
    input.expected_model_digest !== undefined &&
    (typeof input.expected_model_digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(input.expected_model_digest))
  )
    throw new EngineError("INVALID_REQUEST");
  if (
    !Number.isInteger(max_tokens) ||
    max_tokens < 1 ||
    max_tokens > 1024 ||
    !Number.isFinite(temperature) ||
    temperature < 0 ||
    temperature > 2
  )
    throw new EngineError("INVALID_REQUEST");
  return {
    messages,
    max_tokens,
    temperature,
    schema: compile_schema(input.schema),
    signal: input.signal,
    timeout_ms: input.timeout_ms,
    expected_model_digest: input.expected_model_digest,
  };
};
