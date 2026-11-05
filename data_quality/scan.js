import { createHash } from "node:crypto";
import { valid_input } from "./contracts.js";

// Inputs have a fixed schema, so sorted object keys provide canonical provenance.
const canonical = (value) => JSON.stringify(normalize(value));
const normalize = (value) =>
  Array.isArray(value)
    ? value.map(normalize)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, normalize(value[key])]),
        )
      : value;
const hash = (value) =>
  createHash("sha256").update(canonical(value)).digest("hex");
const invalid = () => {
  const error = new Error("INVALID_SKILL_INPUT");
  error.code = "INVALID_SKILL_INPUT";
  throw error;
};

export const scan_environment_assets = (input) => {
  if (!valid_input(input)) invalid();
  const snapshot_digest = hash(input);
  const summary = {
    assets: input.assets.length,
    environments: input.environments.length,
    references: 0,
    duplicate_asset_ids: 0,
    duplicate_environment_ids: 0,
    missing_asset_references: 0,
    ambiguous_asset_references: 0,
    duplicate_asset_references: 0,
    unused_assets: 0,
    identical_content_groups: 0,
  };
  const assets = new Map(),
    environments = new Map(),
    content = new Map(),
    used = new Set();
  const findings = [],
    proposals = [];
  let findings_total = 0,
    proposals_total = 0;
  const finding = (
    code,
    {
      asset_id = null,
      environment_id = null,
      row_index = 0,
      count = 1,
      sample_asset_ids = [],
    } = {},
  ) => {
    findings_total++;
    if (findings.length < 200)
      findings.push({
        code,
        asset_id,
        environment_id,
        row_index,
        count,
        sample_asset_ids,
      });
  };
  input.assets.forEach((row, index) => {
    const prior = assets.get(row.asset_id);
    if (prior) prior.count++;
    else assets.set(row.asset_id, { ...row, index, count: 1 });
  });
  input.environments.forEach((row, index) => {
    const prior = environments.get(row.environment_id);
    if (prior) prior.count++;
    else environments.set(row.environment_id, { index, count: 1 });
  });
  for (const asset of assets.values()) {
    if (asset.count > 1) {
      summary.duplicate_asset_ids++;
      finding("duplicate_asset_id", {
        asset_id: asset.asset_id,
        row_index: asset.index,
        count: asset.count,
      });
    }
    // Ambiguous identifiers never participate in suggested content equivalence.
    if (asset.count === 1) {
      if (!content.has(asset.content_digest))
        content.set(asset.content_digest, []);
      content.get(asset.content_digest).push(asset.asset_id);
    }
  }
  for (const [environment_id, row] of environments)
    if (row.count > 1) {
      summary.duplicate_environment_ids++;
      finding("duplicate_environment_id", {
        environment_id,
        row_index: row.index,
        count: row.count,
      });
    }
  input.environments.forEach((row, index) => {
    const refs = new Map();
    let ambiguous = false;
    for (const asset_id of row.asset_ids) {
      summary.references++;
      used.add(asset_id);
      refs.set(asset_id, (refs.get(asset_id) ?? 0) + 1);
      const asset = assets.get(asset_id);
      if (!asset) summary.missing_asset_references++;
      else if (asset.count > 1) summary.ambiguous_asset_references++;
    }
    for (const [asset_id, count] of refs) {
      const asset = assets.get(asset_id);
      if (!asset) {
        ambiguous = true;
        finding("missing_asset_reference", {
          asset_id,
          environment_id: row.environment_id,
          row_index: index,
          count,
        });
      } else if (asset.count > 1) {
        ambiguous = true;
        finding("ambiguous_asset_reference", {
          asset_id,
          environment_id: row.environment_id,
          row_index: index,
          count,
        });
      }
      if (count > 1) {
        summary.duplicate_asset_references += count - 1;
        finding("duplicate_asset_reference", {
          asset_id,
          environment_id: row.environment_id,
          row_index: index,
          count: count - 1,
        });
      }
    }
    if (
      !ambiguous &&
      environments.get(row.environment_id).count === 1 &&
      refs.size < row.asset_ids.length
    ) {
      proposals_total++;
      if (proposals.length < 100) {
        const proposal = {
          kind: "deduplicate_asset_references",
          environment_id: row.environment_id,
          expected_revision: row.revision,
          expected_asset_ids: [...row.asset_ids],
          proposed_asset_ids: [...refs.keys()],
        };
        proposals.push({
          ...proposal,
          proposal_digest: hash({
            snapshot_digest,
            dataset_revision: input.dataset_revision,
            ...proposal,
          }),
        });
      }
    }
  });
  for (const asset of assets.values())
    if (!used.has(asset.asset_id)) {
      summary.unused_assets++;
      finding("unused_asset", {
        asset_id: asset.asset_id,
        row_index: asset.index,
      });
    }
  for (const ids of content.values())
    if (ids.length > 1) {
      summary.identical_content_groups++;
      finding("identical_asset_content", {
        asset_id: ids[0],
        row_index: assets.get(ids[0]).index,
        count: ids.length,
        sample_asset_ids: ids.slice(0, 8),
      });
    }
  return {
    contract_version: 1,
    skill: "environment-asset-quality",
    skill_version: 1,
    state: findings_total ? "issues_found" : "clean",
    proposals_only: true,
    apply_supported: false,
    snapshot_digest,
    dataset_revision: input.dataset_revision,
    summary,
    findings,
    findings_total,
    findings_truncated: findings_total > findings.length,
    proposals,
    proposals_total,
    proposals_truncated: proposals_total > proposals.length,
  };
};
