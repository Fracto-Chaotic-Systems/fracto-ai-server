# Environment/asset data-quality skill

This is a deterministic, offline consistency scan of an explicitly approved JSON
snapshot, not a live database query or a general data repair agent. `contracts.js`
owns fixed input/output schemas and resource limits; `scan.js` owns linear scans,
pattern groups and proposed corrections; `builtin.js` owns the versioned release,
examples and evaluation cases; `cli.js` invokes the active registry release.

## Input and execution

After the next standard AI service start, run from its repository:

```powershell
node --env-file-if-exists=.env data_quality/cli.js scan approved-snapshot.json
node --env-file-if-exists=.env skills/cli.js run environment-asset-quality approved-snapshot.json
```

From the Fracto root for Docker development:

```powershell
docker compose -f compose.yaml -f compose.dev.yaml exec -T fracto-dev node servers/fracto-ai-server/data_quality/cli.js scan /approved/snapshot.json
```

The input path must already be visible inside that container. No arbitrary host
directory mount, download or remote export is performed. Redirect JSON stdout to
a protected local file to retain a report. Snapshot files are not installed in
Git, automatically persisted or sent to models, HTTP, peers or root logs.

The new snapshot contract is an interchange format, **not** an existing live
data-service export endpoint or a claim about its current database schema:

```json
{
  "contract_version": 1,
  "dataset_revision": 1,
  "assets": [
    { "asset_id": 10, "content_digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
  ],
  "environments": [
    { "environment_id": 20, "revision": 1, "asset_ids": [10, 10] }
  ]
}
```

Supply approved non-personal game-content identifiers and SHA-256 content digests,
never account IDs, names, paths, URLs, logs or private configuration. Fields are
allowlisted; unknown fields and malformed records reject the entire snapshot.
The caller supplies a positive dataset revision and environment revisions from
its source of truth. Digests describe asset content, not people or credentials;
this skill does not read asset files or independently verify the supplied digests.
`asset_ids` represents a set-valued dependency list, not repeated placement
instances. Do not map an instance list whose multiplicity is meaningful into this
contract; removing repeated dependencies is only a proposal even under this rule.

Files are at most 8 MiB UTF-8 JSON, with at most 20000 asset records, 10000
environment records, 64 references per environment, and 250000 references total.
No inference or model loading is required. The scan indexes identifiers/digests
once and processes records/references in bounded memory. It does not compare
every record pair or use random sampling; all admitted records are checked.
Split larger inputs into **complete dependency-closed snapshots**, or use a
future streaming/export contract: arbitrary partitions can create false missing
references and false unused-asset reports.

## Findings, patterns and proposals

The report carries the canonical snapshot SHA-256, dataset revision and active
registry version/definition/executor digests. It reports duplicate asset IDs,
duplicate environment IDs, missing references, ambiguous references to duplicate
asset IDs, repeated references within an environment, unused assets within this
snapshot, and distinct asset IDs with identical supplied content digests.
Identical content and unused assets are patterns, not automatic evidence of bad
data or permission to delete/merge it. No matching filename or semantic guess is
used to replace missing references.

Full counts are computed even when detail is capped: at most 200 diagnostic items,
100 correction proposals and eight sampled asset IDs per content group. Explicit
total/truncated fields distinguish complete aggregate counts from partial detail.
Diagnostic `row_index` is a zero-based input row index; `asset_id` or
`environment_id` is null when not applicable. Duplicate/reference counts describe
extra occurrences or affected references as named in the summary, not rows.

The sole proposal is `deduplicate_asset_references`, preserving first-occurrence
order. It is emitted only for an environment with a unique ID, all referenced
assets present and unambiguous, and at least one repeated reference. Each proposal
retains original references, proposed references, environment/source revisions,
and a deterministic proposal digest bound to the snapshot. These are proposed
preconditions for future review/application, not an update API or trusted command.
Malformed/ambiguous environment targets get no proposals. `apply_supported:false`
and `proposals_only:true` are always present. Applying changes requires step 5's
owning-service operation, state-version validation, authorization and audit/rollback.

The skill neither mutates input nor opens knowledge, service databases, engine
connections or network clients. Findings are not learned facts and are not
automatically imported into knowledge. Evaluations use separate synthetic inputs
and verify full counts, expected diagnostic codes, stable provenance and input
immutability. The shipped `environment-asset-quality` release bootstraps through
the existing registry; publish/evaluate/activate/deactivate commands and code-drift
gates work as for infrastructure references. Existing private AI storage retains
the skill definition and evaluation receipt; there is no new port/dependency/store.

See `../data_quality.test.js` for missing/duplicate/ambiguous references, safe
proposals, truncation/counts, invalid/oversized data, determinism and registry/CLI
integration. This increment does not yet detect arbitrary statistical anomalies,
infer semantic corrections, stream database scans or repair live records.

## Controlled local correction handoff

The data service now owns a separate [snapshot correction store](../../fracto-data-server/corrections/README.md).
Existing live MySQL tables remain outside this path. Export a registered owner's
current snapshot, scan it, then select one displayed proposal:

```powershell
node --env-file-if-exists=.env data_quality/cli.js request current-snapshot.json <proposal-digest> | Set-Content -Encoding utf8 correction-request.json
```

This reruns the active read-only skill and emits only that proposal, source
snapshot/revision and skill provenance. It does not approve or apply anything.
The owner independently verifies the request and requires explicit plan approval.
No new write permission is added to the skill. Use explicit UTF-8 output when
saving JSON in Windows PowerShell, whose ordinary redirection may use UTF-16.
