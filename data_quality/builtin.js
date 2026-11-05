import { input_schema, output_schema } from "./contracts.js";

export const clean_fixture = () => ({
  contract_version: 1,
  dataset_revision: 1,
  assets: [{ asset_id: 1, content_digest: "a".repeat(64) }],
  environments: [{ environment_id: 1, revision: 1, asset_ids: [1] }],
});
export const duplicate_fixture = () => {
  const input = clean_fixture();
  input.environments[0].asset_ids = [1, 1];
  return input;
};
export const data_quality_definition = {
  contract_version: 1,
  skill_id: "environment-asset-quality",
  version: "1.0.0",
  executor: "environment-asset-quality-v1",
  description:
    "Scan an approved environment/asset snapshot for deterministic consistency findings and non-applied correction proposals.",
  procedure: [
    "Validate the bounded snapshot and hash its canonical content.",
    "Index record IDs and scan references for missing, repeated or ambiguous values.",
    "Report complete aggregate counts with bounded issue/pattern details.",
    "Propose only unambiguous reference deduplication, retaining original values and revisions; never apply changes.",
  ],
  permissions: ["snapshot:read"],
  input_schema,
  output_schema,
  examples: [
    {
      input: duplicate_fixture(),
      purpose:
        "Report repeated references with a version-checked proposal, without applying it.",
    },
  ],
  fixtures: [],
  evaluations: [
    { input: clean_fixture(), state: "clean", required_issue_codes: [] },
    {
      input: duplicate_fixture(),
      state: "issues_found",
      required_issue_codes: ["duplicate_asset_reference"],
    },
  ],
};
