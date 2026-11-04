import { DelegationError, error_code } from "./contracts.js";

const SAFE_REJECTIONS = new Set([
  "INVALID_REQUEST",
  "IDEMPOTENCY_CONFLICT",
  "SCOPE_DENIED",
  "QUEUE_FULL",
  "MEMORY_PRESSURE",
  "DISK_PRESSURE",
  "MODEL_MISSING",
  "MODEL_MISMATCH",
  "ENGINE_UNAVAILABLE",
  "ENGINE_BUSY",
  "DEADLINE_EXCEEDED",
  "CLOCK_SKEW",
  "NOT_IMPLEMENTED",
]);
const read_body = async (req) => {
  let length = 0;
  const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 4096) throw new DelegationError("INVALID_REQUEST", 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
  } catch {
    throw new DelegationError("INVALID_REQUEST", 400);
  }
};
export const handle_delegation = async ({
  runtime,
  route,
  req,
  sender,
  send,
}) => {
  try {
    if (!runtime) throw new DelegationError("DELEGATION_UNAVAILABLE", 503);
    if (route.type === "delegation_capabilities")
      return send(200, await runtime.receiver.capabilities());
    if (route.type === "delegation_submit") {
      const result = await runtime.receiver.accept(
        sender,
        await read_body(req),
      );
      return send(result.status, result.value);
    }
    if (route.type === "delegation_cancel")
      return send(200, runtime.receiver.cancel(sender, route.id));
    return send(200, runtime.receiver.inspect(sender, route.id));
  } catch (error) {
    const code = error_code(error);
    const status =
      Number.isInteger(error.status) &&
      [400, 403, 404, 408, 409, 413, 429, 503].includes(error.status)
        ? error.status
        : 503;
    const value = { contract_version: 1, error: code };
    if (route.type === "delegation_submit")
      value.acceptance = SAFE_REJECTIONS.has(code) ? "rejected" : "unknown";
    send(status, value);
  }
};
