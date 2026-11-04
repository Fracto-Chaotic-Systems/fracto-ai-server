const messages = Object.freeze({
  ENGINE_UNAVAILABLE: "Inference engine is unavailable",
  MODEL_MISSING: "A configured local model is required",
  MODEL_MISMATCH: "The configured model does not match the required digest",
  ENGINE_BUSY: "Inference capacity is busy",
  DEADLINE_EXCEEDED: "Inference deadline exceeded",
  CANCELLED: "Inference request cancelled",
  INVALID_REQUEST: "Invalid inference request",
  INVALID_OUTPUT: "Model output failed validation",
  UNSUPPORTED_OPERATION: "Inference operation is unsupported",
  NOT_IMPLEMENTED: "Engine adapter is not implemented",
  PROTOCOL_ERROR: "Invalid engine response",
  CONFIGURATION_ERROR: "Invalid inference engine configuration",
});

export class EngineError extends Error {
  constructor(code) {
    super(messages[code] || messages.PROTOCOL_ERROR);
    this.name = "EngineError";
    this.code = Object.hasOwn(messages, code) ? code : "PROTOCOL_ERROR";
  }
  toJSON() {
    return { code: this.code, message: this.message };
  }
}

/** A single deadline covers metadata, transport, body consumption and validation. */
export const with_deadline = async (
  operation,
  { signal, timeout_ms = 180000 } = {},
) => {
  if (
    !Number.isInteger(timeout_ms) ||
    timeout_ms < 1 ||
    timeout_ms > 180000 ||
    (signal != null && !(signal instanceof AbortSignal))
  )
    throw new EngineError("INVALID_REQUEST");
  if (signal?.aborted) throw new EngineError("CANCELLED");
  const deadline = new AbortController();
  const combined = signal
    ? AbortSignal.any([signal, deadline.signal])
    : deadline.signal;
  const timer = setTimeout(() => deadline.abort(), timeout_ms);
  try {
    return await operation(combined);
  } catch (error) {
    if (signal?.aborted) throw new EngineError("CANCELLED");
    if (deadline.signal.aborted) throw new EngineError("DEADLINE_EXCEEDED");
    if (error instanceof EngineError) throw error;
    throw new EngineError("ENGINE_UNAVAILABLE");
  } finally {
    clearTimeout(timer);
    deadline.abort();
  }
};
