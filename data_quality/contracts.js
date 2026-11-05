import { compile_schema } from "../engines/contracts.js";

export const issue_codes = [
  "duplicate_asset_id",
  "duplicate_environment_id",
  "missing_asset_reference",
  "ambiguous_asset_reference",
  "duplicate_asset_reference",
  "unused_asset",
  "identical_asset_content",
];
const object = (properties) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const integer = (maximum) => ({ type: "integer", minimum: 0, maximum });
const id = { type: "integer", minimum: 1, maximum: 2147483647 };
const digest = { type: "string", minLength: 64, maxLength: 64 };
const array = (items, maxItems) => ({ type: "array", maxItems, items });
const refs = array(id, 64);
export const input_schema = object({
  contract_version: { const: 1 },
  dataset_revision: id,
  assets: array(object({ asset_id: id, content_digest: digest }), 20000),
  environments: array(
    object({ environment_id: id, revision: id, asset_ids: refs }),
    10000,
  ),
});
export const output_schema = object({
  contract_version: { const: 1 },
  skill: { const: "environment-asset-quality" },
  skill_version: { const: 1 },
  state: { enum: ["clean", "issues_found"] },
  proposals_only: { const: true },
  apply_supported: { const: false },
  snapshot_digest: digest,
  dataset_revision: id,
  summary: object({
    assets: integer(20000),
    environments: integer(10000),
    references: integer(250000),
    duplicate_asset_ids: integer(20000),
    duplicate_environment_ids: integer(10000),
    missing_asset_references: integer(250000),
    ambiguous_asset_references: integer(250000),
    duplicate_asset_references: integer(250000),
    unused_assets: integer(20000),
    identical_content_groups: integer(20000),
  }),
  findings: array(
    object({
      code: { enum: issue_codes },
      asset_id: { type: ["integer", "null"], minimum: 1, maximum: 2147483647 },
      environment_id: {
        type: ["integer", "null"],
        minimum: 1,
        maximum: 2147483647,
      },
      row_index: integer(20000),
      count: integer(250000),
      sample_asset_ids: array(id, 8),
    }),
    200,
  ),
  findings_total: integer(1000000),
  findings_truncated: { type: "boolean" },
  proposals: array(
    object({
      kind: { const: "deduplicate_asset_references" },
      environment_id: id,
      expected_revision: id,
      expected_asset_ids: refs,
      proposed_asset_ids: refs,
      proposal_digest: digest,
    }),
    100,
  ),
  proposals_total: integer(10000),
  proposals_truncated: { type: "boolean" },
});
const input_validator = compile_schema(input_schema).validate;
export const output_validator = compile_schema(output_schema).validate;
export const valid_input = (input) => {
  if (!input_validator(input)) return false;
  if (Buffer.byteLength(JSON.stringify(input)) > 8 * 1024 ** 2) return false;
  if (
    input.assets.some((asset) => !/^[a-f0-9]{64}$/.test(asset.content_digest))
  )
    return false;
  return (
    input.environments.reduce((sum, row) => sum + row.asset_ids.length, 0) <=
    250000
  );
};
