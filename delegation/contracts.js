import { hash, normalize_request, uuid } from "../inference/contracts.js";
import {
  exact,
  integer,
  digest_id,
  result_contract,
} from "../exchange/contracts.js";
import { ENGINE_IDS } from "../engines/contracts.js";

export const ERRORS = new Set([
  "INVALID_REQUEST",
  "IDEMPOTENCY_CONFLICT",
  "QUEUE_FULL",
  "MEMORY_PRESSURE",
  "DISK_PRESSURE",
  "MODEL_MISSING",
  "MODEL_MISMATCH",
  "ENGINE_UNAVAILABLE",
  "ENGINE_BUSY",
  "DEADLINE_EXCEEDED",
  "CANCELLED",
  "INVALID_OUTPUT",
  "INTERRUPTED",
  "CONFIGURATION_CHANGED",
  "CONFIGURATION_ERROR",
  "NOT_IMPLEMENTED",
  "PROTOCOL_ERROR",
  "UNSUPPORTED_OPERATION",
  "INFERENCE_UNAVAILABLE",
  "STORAGE_UNAVAILABLE",
  "DELEGATION_UNAVAILABLE",
  "DELEGATION_NOT_FOUND",
  "PEER_NOT_ALLOWED",
  "SCOPE_DENIED",
  "PEER_BUSY",
  "PEER_UNAVAILABLE",
  "PEER_DEADLINE_EXCEEDED",
  "CLOCK_SKEW",
  "INVALID_RECEIPT",
  "OUTCOME_UNKNOWN",
  "RECONCILIATION_EXPIRED",
]);
export class DelegationError extends Error {
  constructor(code = "INVALID_REQUEST", status = 400) {
    super(ERRORS.has(code) ? code : "DELEGATION_UNAVAILABLE");
    this.code = this.message;
    this.status = status;
  }
}
export const fail = (code, status) => {
  throw new DelegationError(code, status);
};
export const error_code = (error) =>
  ERRORS.has(error?.code) ? error.code : "DELEGATION_UNAVAILABLE";
export const expected_contract = (value) => {
  try {
    exact(value, ["engine", "model_digest", "profile_version"]);
    if (
      !ENGINE_IDS.includes(value.engine) ||
      !digest_id(value.model_digest) ||
      value.profile_version !== 1
    )
      fail();
    return {
      engine: value.engine,
      model_digest: value.model_digest,
      profile_version: 1,
    };
  } catch {
    fail();
  }
};
export const local_request = (value) => {
  if (
    !value ||
    Object.keys(value).some(
      (key) =>
        ![
          "contract_version",
          "idempotency_key",
          "peer_id",
          "expected",
          "operation",
          "input",
          "deadline_ms",
          "max_output_tokens",
        ].includes(key),
    )
  )
    fail();
  try {
    if (!uuid(value.peer_id)) fail();
    const request = normalize_request({
      contract_version: value.contract_version,
      idempotency_key: value.idempotency_key,
      operation: value.operation,
      input: value.input,
      deadline_ms: value.deadline_ms,
      max_output_tokens: value.max_output_tokens,
    });
    return {
      idempotency_key: value.idempotency_key,
      peer_id: value.peer_id,
      expected: expected_contract(value.expected),
      request,
    };
  } catch {
    fail();
  }
};
export const wire_request = (value, sender) => {
  try {
    exact(value, [
      "contract_version",
      "origin_node_id",
      "origin_request_id",
      "origin_idempotency_key",
      "hop_count",
      "created_at",
      "deadline_at",
      "remaining_ms",
      "expected",
      "request",
    ]);
    exact(value.request, ["operation", "input", "max_output_tokens"]);
    if (
      value.contract_version !== 1 ||
      value.origin_node_id !== sender ||
      !uuid(sender) ||
      !uuid(value.origin_request_id) ||
      !uuid(value.origin_idempotency_key) ||
      value.hop_count !== 1 ||
      !integer(value.created_at) ||
      !integer(
        value.deadline_at,
        value.created_at + 100,
        value.created_at + 180000,
      ) ||
      !integer(value.remaining_ms, 1, 180000) ||
      !integer(value.request.max_output_tokens, 32, 512)
    )
      fail();
    const normalized = normalize_request({
      contract_version: 1,
      idempotency_key: value.origin_idempotency_key,
      operation: value.request.operation,
      input: value.request.input,
      max_output_tokens: value.request.max_output_tokens,
    });
    return {
      contract_version: 1,
      origin_node_id: sender,
      origin_request_id: value.origin_request_id,
      origin_idempotency_key: value.origin_idempotency_key,
      hop_count: 1,
      created_at: value.created_at,
      deadline_at: value.deadline_at,
      remaining_ms: value.remaining_ms,
      expected: expected_contract(value.expected),
      request: {
        operation: normalized.operation,
        input: normalized.input,
        max_output_tokens: normalized.max_output_tokens,
      },
    };
  } catch {
    fail();
  }
};
export const request_hash = (wire) => {
  const { remaining_ms, ...stable } = wire;
  return hash(JSON.stringify(stable));
};
export const receiver_key = (sender, key) => {
  const bytes = Buffer.from(
    hash(JSON.stringify([sender, key])).slice(0, 32),
    "hex",
  );
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const text = bytes.toString("hex");
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
};
export const REMOTE_STATES = [
  "queued",
  "running",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
  "expired",
  "interrupted",
];
export const terminal_remote = (state) =>
  ["completed", "failed", "cancelled", "expired", "interrupted"].includes(
    state,
  );
export const receipt_contract = (value, row, executor) => {
  try {
    exact(value, [
      "contract_version",
      "origin_node_id",
      "origin_request_id",
      "executor_node_id",
      "request_hash",
      "deadline_at",
      "state",
      "created_at",
      "started_at",
      "finished_at",
      "attempt_count",
      "error",
      "result",
    ]);
    if (
      value.contract_version !== 1 ||
      value.origin_node_id !== row.origin_node_id ||
      value.origin_request_id !== row.id ||
      value.executor_node_id !== executor ||
      value.request_hash !== row.request_hash ||
      !integer(value.deadline_at, 0, row.deadline_at) ||
      !REMOTE_STATES.includes(value.state) ||
      !integer(value.created_at) ||
      !(value.started_at === null || integer(value.started_at)) ||
      !(value.finished_at === null || integer(value.finished_at)) ||
      !integer(value.attempt_count, 0, 1) ||
      !(value.error === null || ERRORS.has(value.error)) ||
      terminal_remote(value.state) !== (value.finished_at !== null) ||
      (value.started_at !== null && value.started_at < value.created_at)
    )
      fail("INVALID_RECEIPT", 502);
    let result = null;
    if (value.state === "completed") {
      if (value.error !== null || value.finished_at >= value.deadline_at)
        fail("INVALID_RECEIPT", 502);
      result = result_contract(value.result);
      if (
        result.provenance.engine !== row.expected.engine ||
        result.provenance.model_digest !== row.expected.model_digest ||
        result.provenance.profile_version !== row.expected.profile_version ||
        result.provenance.max_output_tokens !== row.request.max_output_tokens
      )
        fail("INVALID_RECEIPT", 502);
    } else if (value.result !== null) fail("INVALID_RECEIPT", 502);
    return {
      contract_version: 1,
      origin_node_id: value.origin_node_id,
      origin_request_id: value.origin_request_id,
      executor_node_id: executor,
      request_hash: value.request_hash,
      deadline_at: value.deadline_at,
      state: value.state,
      created_at: value.created_at,
      started_at: value.started_at,
      finished_at: value.finished_at,
      attempt_count: value.attempt_count,
      error: value.error,
      result,
    };
  } catch {
    fail("INVALID_RECEIPT", 502);
  }
};
export const public_receipt = (row) => ({
  contract_version: 1,
  request_id: row.id,
  peer_id: row.peer_id,
  origin_node_id: row.origin_node_id,
  executor_node_id: row.receipt?.executor_node_id || null,
  state: row.state,
  remote_state: row.receipt?.state || null,
  created_at: row.created_at,
  deadline_at: row.deadline_at,
  finished_at: row.finished_at,
  expected: expected_contract(row.expected),
  cancel_requested: row.cancel_requested,
  reconciling: row.reconciling,
  error: row.error,
  result_available: row.state === "completed",
});
