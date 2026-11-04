import { EngineError } from "./errors.js";
import { model_id } from "./contracts.js";

const counter = (value) =>
  Number.isSafeInteger(value) && value >= 0 ? value : null;
const duration_ms = (value) =>
  Number.isFinite(value) && value >= 0 ? value / 1000000 : null;
export const inventory = (body) => {
  if (!Array.isArray(body.models) || body.models.length > 1024)
    throw new EngineError("PROTOCOL_ERROR");
  try {
    return body.models.map((entry) => {
      if (
        typeof entry.digest !== "string" ||
        !/^[a-f0-9]{64}$/i.test(entry.digest) ||
        counter(entry.size) === null
      )
        throw new Error();
      return {
        id: model_id(entry.name),
        digest: entry.digest.toLowerCase(),
        size_bytes: entry.size,
      };
    });
  } catch {
    throw new EngineError("PROTOCOL_ERROR");
  }
};
export const version = (body) => {
  if (
    typeof body.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(body.version) ||
    body.version.length > 64
  )
    throw new EngineError("PROTOCOL_ERROR");
  return body.version;
};
export const normalized_result = (
  body,
  { model, digest, engine_version, schema },
) => {
  try {
    if (model_id(body.model) !== model) throw new Error();
  } catch {
    throw new EngineError("PROTOCOL_ERROR");
  }
  if (
    body.done !== true ||
    body.message?.role !== "assistant" ||
    typeof body.message.content !== "string" ||
    Buffer.byteLength(body.message.content) > 65536
  )
    throw new EngineError("PROTOCOL_ERROR");
  if (body.message.tool_calls?.length)
    throw new EngineError("UNSUPPORTED_OPERATION");
  let structured = null;
  if (schema) {
    try {
      structured = JSON.parse(body.message.content);
      if (!schema.validate(structured)) throw new Error();
    } catch {
      throw new EngineError("INVALID_OUTPUT");
    }
  }
  return {
    engine: "ollama",
    engine_version,
    model,
    model_digest: digest,
    text: body.message.content,
    structured,
    finish_reason: ["stop", "length"].includes(body.done_reason)
      ? body.done_reason
      : "unknown",
    usage: {
      input_tokens: counter(body.prompt_eval_count),
      output_tokens: counter(body.eval_count),
    },
    timings_ms: {
      total: duration_ms(body.total_duration),
      load: duration_ms(body.load_duration),
      input: duration_ms(body.prompt_eval_duration),
      output: duration_ms(body.eval_duration),
    },
  };
};
