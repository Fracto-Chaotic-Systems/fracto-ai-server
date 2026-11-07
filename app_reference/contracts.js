import { compile_schema } from "../engines/contracts.js";

const string = (max) => ({ type: "string", minLength: 1, maxLength: max });
const object = (properties) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const array = (items, max) => ({ type: "array", maxItems: max, items });
const hash = { type: "string", minLength: 64, maxLength: 64 };
export const input_schema = object({ question: string(512) });
export const output_schema = object({
  contract_version: { const: 1 },
  skill: { const: "app-reference" },
  skill_version: { const: 1 },
  answer_type: { const: "extractive_reference" },
  state: { enum: ["evidence_found", "insufficient_evidence"] },
  evidence_only: { const: true },
  live_verified: { const: false },
  snapshot: object({
    provider: { const: "ui-features" },
    subject: { const: "application-ui" },
    digest: hash,
    provider_digest: hash,
    published_at: { type: "integer", minimum: 0 },
  }),
  findings: array(
    object({
      citation: { type: "integer", minimum: 1, maximum: 5 },
      quote: string(600),
      matched_terms: array(string(512), 12),
      document_id: string(32),
      source: string(80),
      revision: string(80),
      digest: hash,
      chunk: { type: "integer", minimum: 0 },
      start: { type: "integer", minimum: 0 },
      end: { type: "integer", minimum: 0 },
    }),
    5,
  ),
  unmatched_terms: array(string(512), 12),
  limits: object({
    findings: { const: 5 },
    quote_characters: { const: 600 },
    question_terms: { const: 12 },
  }),
});
export const input_validator = compile_schema(input_schema).validate;
const validate_shape = compile_schema(output_schema).validate;
export const output_validator = (value) =>
  validate_shape(value) &&
  [
    value.snapshot.digest,
    value.snapshot.provider_digest,
    ...value.findings.map((finding) => finding.digest),
  ].every((digest) => /^[a-f0-9]{64}$/.test(digest));
