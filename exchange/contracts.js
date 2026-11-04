import {
  hash,
  normalize_request,
  uuid,
  validate_output,
} from "../inference/contracts.js";
import { ENGINE_IDS } from "../engines/contracts.js";

export const PAGE_SIZE = 4;
export const MAX_ARTIFACT_BYTES = 8192;
export class ArtifactError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
export const deny = (code = "INVALID_ARTIFACT", status) => {
  throw new ArtifactError(code, status);
};
export const exact = (value, keys) => {
  if (
    !value ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    deny();
};
export const digest_id = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const integer = (
  value,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
) => Number.isSafeInteger(value) && value >= minimum && value <= maximum;
export const origin = (value) => {
  exact(value, ["node_id", "epoch", "sequence"]);
  if (!uuid(value.node_id) || !uuid(value.epoch) || !integer(value.sequence, 1))
    deny();
  return {
    node_id: value.node_id,
    epoch: value.epoch,
    sequence: value.sequence,
  };
};
const counter = (value, whole = false) => {
  if (value === null) return null;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1e12 ||
    (whole && !Number.isSafeInteger(value))
  )
    deny();
  return value;
};
export const result_contract = (value) => {
  exact(value, ["contract_version", "operation", "output", "provenance"]);
  const p = value.provenance;
  exact(p, [
    "engine",
    "engine_version",
    "model_digest",
    "template_version",
    "schema_version",
    "profile_version",
    "temperature",
    "max_output_tokens",
    "context_tokens",
    "cpu_threads",
    "usage",
    "timings_ms",
  ]);
  if (
    value.contract_version !== 1 ||
    value.operation !== "assess_performance" ||
    !ENGINE_IDS.includes(p.engine) ||
    typeof p.engine_version !== "string" ||
    p.engine_version.length > 32 ||
    !/^\d+\.\d+\.\d+$/.test(p.engine_version) ||
    !digest_id(p.model_digest) ||
    p.template_version !== 1 ||
    p.schema_version !== 1 ||
    p.profile_version !== 1 ||
    p.temperature !== 0 ||
    !integer(p.max_output_tokens, 32, 512) ||
    p.context_tokens !== 4096 ||
    p.cpu_threads !== 2
  )
    deny();
  exact(p.usage, ["input_tokens", "output_tokens"]);
  exact(p.timings_ms, ["total", "load", "input", "output"]);
  let output;
  try {
    output = validate_output(value.output);
  } catch {
    deny();
  }
  return {
    contract_version: 1,
    operation: "assess_performance",
    output,
    provenance: {
      engine: p.engine,
      engine_version: p.engine_version,
      model_digest: p.model_digest,
      template_version: 1,
      schema_version: 1,
      profile_version: 1,
      temperature: 0,
      max_output_tokens: p.max_output_tokens,
      context_tokens: 4096,
      cpu_threads: 2,
      usage: {
        input_tokens: counter(p.usage.input_tokens, true),
        output_tokens: counter(p.usage.output_tokens, true),
      },
      timings_ms: Object.fromEntries(
        ["total", "load", "input", "output"].map((key) => [
          key,
          counter(p.timings_ms[key]),
        ]),
      ),
    },
  };
};
export const record_contract = (value) => {
  exact(value, [
    "contract_version",
    "origin",
    "operation",
    "request_created_at",
    "completed_at",
    "input",
    "result",
  ]);
  if (
    value.contract_version !== 1 ||
    value.operation !== "assess_performance" ||
    !integer(value.request_created_at) ||
    !integer(value.completed_at, value.request_created_at) ||
    value.completed_at > Date.now() + 300000
  )
    deny();
  let input;
  try {
    input = normalize_request({
      contract_version: 1,
      idempotency_key: "00000000-0000-4000-8000-000000000000",
      operation: value.operation,
      input: value.input,
    }).input;
  } catch {
    deny();
  }
  return {
    contract_version: 1,
    origin: origin(value.origin),
    operation: "assess_performance",
    request_created_at: value.request_created_at,
    completed_at: value.completed_at,
    input,
    result: result_contract(value.result),
  };
};
export const record_bytes = (value) => {
  const bytes = Buffer.from(JSON.stringify(record_contract(value)));
  if (bytes.length > MAX_ARTIFACT_BYTES) deny();
  return bytes;
};
export const entry_contract = (value) => {
  exact(value, ["sequence", "digest", "size_bytes", "origin"]);
  if (
    !integer(value.sequence, 1) ||
    !digest_id(value.digest) ||
    !integer(value.size_bytes, 1, MAX_ARTIFACT_BYTES)
  )
    deny();
  return {
    sequence: value.sequence,
    digest: value.digest,
    size_bytes: value.size_bytes,
    origin: origin(value.origin),
  };
};
export const parse_record = (bytes, expected) => {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length > MAX_ARTIFACT_BYTES ||
    bytes.length !== expected.size_bytes ||
    hash(bytes) !== expected.digest
  )
    deny("HASH_MISMATCH");
  let record;
  try {
    record = record_contract(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
  } catch {
    deny();
  }
  // Enforce one canonical encoding: duplicate JSON keys and hidden discarded text
  // cannot enter storage even when JSON.parse would accept them.
  if (
    !record_bytes(record).equals(bytes) ||
    JSON.stringify(record.origin) !== JSON.stringify(origin(expected.origin))
  )
    deny();
  return record;
};
export const manifest_contract = (value, cursor) => {
  exact(value, [
    "contract_version",
    "epoch",
    "cursor",
    "next_cursor",
    "has_more",
    "entries",
  ]);
  if (
    value.contract_version !== 1 ||
    !uuid(value.epoch) ||
    value.cursor !== cursor ||
    !integer(value.next_cursor, cursor) ||
    typeof value.has_more !== "boolean" ||
    !Array.isArray(value.entries) ||
    value.entries.length > PAGE_SIZE
  )
    deny("INVALID_MANIFEST");
  const entries = value.entries.map(entry_contract);
  let previous = cursor;
  const digests = new Set();
  for (const entry of entries) {
    if (entry.sequence <= previous || digests.has(entry.digest))
      deny("INVALID_MANIFEST");
    previous = entry.sequence;
    digests.add(entry.digest);
  }
  if (previous !== value.next_cursor || (!entries.length && value.has_more))
    deny("INVALID_MANIFEST");
  return {
    contract_version: 1,
    epoch: value.epoch,
    cursor,
    next_cursor: previous,
    has_more: value.has_more,
    entries,
  };
};
