import { createHash } from "node:crypto";
import {
  compile_schema,
  exact_fields,
  plain_object,
} from "../engines/contracts.js";

export class InferenceError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
export const fail = (code, status) => {
  throw new InferenceError(code, status);
};
export const uuid = (value) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    value,
  );
export const hash = (value) => createHash("sha256").update(value).digest("hex");
export const schema = {
  type: "object",
  additionalProperties: false,
  required: ["severity", "reason", "recommendation"],
  properties: {
    severity: { type: "string", enum: ["normal", "warning", "critical"] },
    reason: {
      type: "string",
      enum: [
        "normal",
        "cpu_pressure",
        "memory_pressure",
        "queue_backlog",
        "request_latency",
        "failure_rate",
      ],
    },
    recommendation: {
      type: "string",
      enum: [
        "observe",
        "reduce_concurrency",
        "defer_background_work",
        "investigate_failures",
      ],
    },
  },
};
const output_validator = compile_schema(schema).validate;
export const validate_output = (value) => {
  if (!output_validator(value)) fail("INVALID_OUTPUT", 502);
  // Rebuild the object: no unrecognized provider fields reach storage or APIs.
  return {
    severity: value.severity,
    reason: value.reason,
    recommendation: value.recommendation,
  };
};
export const normalize_request = (body) => {
  try {
    exact_fields(body, [
      "contract_version",
      "idempotency_key",
      "operation",
      "input",
      "deadline_ms",
      "max_output_tokens",
    ]);
    if (
      body.contract_version !== 1 ||
      !uuid(body.idempotency_key) ||
      body.operation !== "assess_performance"
    )
      fail("INVALID_REQUEST");
    const limits = {
      cpu_percent: 100,
      available_memory_mib: 1048576,
      queue_depth: 1000000,
      failure_percent: 100,
      p95_latency_ms: 3600000,
    };
    if (!plain_object(body.input)) fail("INVALID_REQUEST");
    exact_fields(body.input, Object.keys(limits));
    const input = {};
    for (const [key, max] of Object.entries(limits)) {
      const value = body.input[key];
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < 0 ||
        value > max
      )
        fail("INVALID_REQUEST");
      input[key] = value;
    }
    const deadline_ms = body.deadline_ms ?? 180000;
    const max_output_tokens = body.max_output_tokens ?? 256;
    if (
      !Number.isInteger(deadline_ms) ||
      deadline_ms < 100 ||
      deadline_ms > 180000 ||
      !Number.isInteger(max_output_tokens) ||
      max_output_tokens < 32 ||
      max_output_tokens > 512
    )
      fail("INVALID_REQUEST");
    return {
      operation: "assess_performance",
      input,
      deadline_ms,
      max_output_tokens,
      template_version: 1,
      schema_version: 1,
      profile_version: 1,
      temperature: 0,
    };
  } catch {
    fail("INVALID_REQUEST");
  }
};
export const messages_for = (request) => [
  {
    role: "system",
    content:
      "Assess this aggregate performance sample. Return only the specified JSON object. Propose one advisory recommendation; do not execute actions. Use normal/normal/observe if no pressure is evident.",
  },
  { role: "user", content: JSON.stringify(request.input) },
];
export const public_job = (job) => ({
  contract_version: 1,
  request_id: job.id,
  operation: job.request.operation,
  state: job.state,
  created_at: job.created_at,
  started_at: job.started_at,
  finished_at: job.finished_at,
  deadline_at: job.deadline_at,
  attempt_count: job.attempt_count,
  error: job.error,
  result_available: job.state === "completed",
});
