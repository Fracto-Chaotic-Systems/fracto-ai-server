import { createHash } from "node:crypto";
import { compile_schema } from "../engines/contracts.js";
import {
  input_schema as quality_input,
  output_schema as quality_output,
  valid_input as quality_valid,
  issue_codes,
} from "../data_quality/contracts.js";
import {
  input_schema as app_input,
  output_schema as app_output,
  input_validator as app_valid,
  output_validator as app_output_valid,
} from "../app_reference/contracts.js";

export class SkillError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
export const fail = (code) => {
  throw new SkillError(code);
};
export const canonical = (value) => JSON.stringify(sort(value));
const sort = (value) =>
  Array.isArray(value)
    ? value.map(sort)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, sort(value[key])]),
        )
      : value;
export const hash = (value) => createHash("sha256").update(value).digest("hex");
export const label = (value) => {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(value))
    fail("INVALID_SKILL");
};
export const version_label = (value) => {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})$/.test(
      value,
    )
  )
    fail("INVALID_VERSION");
};
const string = (max) => ({ type: "string", minLength: 1, maxLength: max });
const array = (items, max) => ({ type: "array", maxItems: max, items });
const object = (properties) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
export const input_schema = object({ question: string(512) });
export const output_schema = object({
  contract_version: { const: 1 },
  skill: { const: "infrastructure-reference" },
  skill_version: { const: 1 },
  answer_type: { const: "extractive_reference" },
  state: { enum: ["evidence_found", "insufficient_evidence"] },
  evidence_only: { const: true },
  live_verified: { const: false },
  findings: array(
    object({
      citation: { type: "integer", minimum: 1, maximum: 5 },
      quote: string(600),
      matched_terms: array(string(512), 12),
      source: string(80),
      revision: string(80),
      digest: string(64),
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
const input_validator = compile_schema(input_schema).validate;
export const output_validator = compile_schema(output_schema).validate;
export const validate_input = (
  input,
  executor = "infrastructure-reference-v1",
) => {
  if (
    !(executor === "environment-asset-quality-v1"
      ? quality_valid(input)
      : executor === "app-reference-v1"
        ? app_valid(input)
        : input_validator(input))
  )
    fail("INVALID_SKILL_INPUT");
};
export const profile_for = (executor) => {
  if (executor === "app-reference-v1")
    return {
      id: "app-reference",
      permission: "bundle:read",
      input: app_input,
      output: app_output,
      validate_output: app_output_valid,
    };
  if (executor === "infrastructure-reference-v1")
    return {
      id: "infrastructure-reference",
      permission: "knowledge:read",
      input: input_schema,
      output: output_schema,
      validate_output: output_validator,
    };
  if (executor === "environment-asset-quality-v1")
    return {
      id: "environment-asset-quality",
      permission: "snapshot:read",
      input: quality_input,
      output: quality_output,
      validate_output: compile_quality_output,
    };
  fail("EXECUTOR_UNAVAILABLE");
};
const compile_quality_output = compile_schema(quality_output).validate;
const definition_schema = (executor = "infrastructure-reference-v1") => {
  const quality = executor === "environment-asset-quality-v1";
  const profile = profile_for(executor);
  return object({
    contract_version: { const: 1 },
    skill_id: {
      const: profile.id,
    },
    version: string(11),
    executor: {
      const: executor,
    },
    description: string(1024),
    procedure: { type: "array", minItems: 1, maxItems: 8, items: string(512) },
    permissions: {
      type: "array",
      minItems: 1,
      maxItems: 1,
      items: { const: profile.permission },
    },
    input_schema: { type: "object" },
    output_schema: { type: "object" },
    examples: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: object({
        input: profile.input,
        purpose: string(512),
      }),
    },
    fixtures: {
      type: "array",
      minItems: quality ? 0 : 1,
      maxItems: quality ? 0 : 4,
      items: object({ source: string(80), text: string(8192) }),
    },
    evaluations: {
      type: "array",
      minItems: 2,
      maxItems: 8,
      items: quality
        ? object({
            input: quality_input,
            state: { enum: ["clean", "issues_found"] },
            required_issue_codes: array({ enum: issue_codes }, 7),
          })
        : object({
            input: profile.input,
            state: { enum: ["evidence_found", "insufficient_evidence"] },
            required_sources: array(string(80), 4),
          }),
    },
  });
};
const definition_validator = compile_schema(definition_schema()).validate;
const quality_definition_validator = compile_schema(
  definition_schema("environment-asset-quality-v1"),
).validate;
const app_definition_validator = compile_schema(
  definition_schema("app-reference-v1"),
).validate;
export const normalize_definition = (value) => {
  let text;
  try {
    text = canonical(value);
  } catch {
    fail("INVALID_DEFINITION");
  }
  if (!text || Buffer.byteLength(text) > 32768) fail("INVALID_DEFINITION");
  const definition = JSON.parse(text);
  const quality = definition.executor === "environment-asset-quality-v1";
  if (
    !(quality
      ? quality_definition_validator(definition)
      : definition.executor === "app-reference-v1"
        ? app_definition_validator(definition)
        : definition_validator(definition))
  )
    fail("INVALID_DEFINITION");
  const profile = profile_for(definition.executor);
  version_label(definition.version);
  if (
    canonical(definition.input_schema) !== canonical(profile.input) ||
    canonical(definition.output_schema) !== canonical(profile.output)
  )
    fail("INVALID_DEFINITION");
  const sources = new Set();
  for (const fixture of definition.fixtures) {
    label(fixture.source);
    if (
      definition.executor === "app-reference-v1" &&
      (!/^app-11-ui-features-[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(
        fixture.source,
      ) ||
        fixture.source.slice(19).length > 32 ||
        fixture.source === "app-11-ui-features-mandatory")
    )
      fail("INVALID_DEFINITION");
    if (sources.has(fixture.source)) fail("INVALID_DEFINITION");
    sources.add(fixture.source);
  }
  for (const example of definition.examples)
    validate_input(example.input, definition.executor);
  for (const check of definition.evaluations) {
    validate_input(check.input, definition.executor);
    if (quality) continue;
    if (check.required_sources.some((source) => !sources.has(source)))
      fail("INVALID_DEFINITION");
    if (
      check.state === "insufficient_evidence" &&
      check.required_sources.length
    )
      fail("INVALID_DEFINITION");
  }
  return definition;
};
