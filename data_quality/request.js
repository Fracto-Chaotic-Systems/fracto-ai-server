import { fail } from "../skills/contracts.js";

/** Select one proposal; this envelope carries no approval or write capability. */
export const select_correction_request = (report, proposal_digest) => {
  if (
    typeof proposal_digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(proposal_digest)
  )
    fail("INVALID_PROPOSAL_DIGEST");
  const proposal = report.proposals.find(
    (item) => item.proposal_digest === proposal_digest,
  );
  if (!proposal) fail("PROPOSAL_NOT_FOUND");
  return {
    contract_version: 1,
    snapshot_digest: report.snapshot_digest,
    dataset_revision: report.dataset_revision,
    proposal: structuredClone(proposal),
    skill: {
      id: "environment-asset-quality",
      version: report.registry.version,
      definition_digest: report.registry.definition_digest,
      executor_digest: report.registry.executor_digest,
    },
  };
};
