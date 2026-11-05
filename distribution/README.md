# Knowledge and skill peer distribution

This is a separate persistent candidate catalog, not an extension of inference
artifact retention or a fleet authority. `contracts.js` validates canonical wire
records/manifests; `storage.js` owns publication, candidates, cursors, quarantine
and adoption receipts; `sync.js` performs bounded mTLS pulls; `runtime.js` schedules
them through the existing peer worker; `adopt.js` performs explicit local handoff;
`cli.js` is local administration. No code, model weights, credentials, approvals,
activation selections, evaluations, corrections or live datasets are distributed.

## Publication and trust

New independent directional scopes are `knowledge:exchange` and `skills:exchange`.
Existing `artifacts:exchange`, status and delegation grants do not grant either.
Enroll both upgraded nodes with independently verified fingerprints using the
existing peer CLI and the desired comma-separated inbound/outbound scopes. Scope
revocation/trust reload cancels pending work and disconnects sockets as before.
The transport remains the separate TLS 1.3 pinned mutually authenticated listener;
no HTTP text/administration endpoints, new ports or discovery are added.

Publishing requires local review and the explicit `--approved-nonpersonal` argument.
Review all text/examples/fixtures for personal information, secrets, logs and
deployment configuration. This is an administrative attestation, not an automated
PII detector or a claim that authentication makes content safe. Nothing is
published merely because it is stored locally, shipped by the app or imported.
Only allowlisted fields enter wire records. Peer locations remain in protected
trust configuration, never record bodies. Questions/results and correction
snapshots/approval receipts are outside this protocol.

Records have immutable origin node/epoch/sequence, canonical SHA-256 and bounded
payloads: one approved knowledge revision (at most 64 KiB UTF-8) or one skill
definition (at most 32 KiB, validated against shipped executor/schema profiles).
Origin tuples survive explicit relays and suppress duplicate/conflicting records.
mTLS authenticates the immediate sender, not an independently signed origin claim;
received content remains untrusted evidence. Hashes establish integrity, not truth.

## Local workflow

Run from the AI service directory after ordinary peer startup initialized identity:

```powershell
node --env-file-if-exists=.env distribution/cli.js status
node --env-file-if-exists=.env distribution/cli.js publish-knowledge terrain-contract revision-1 --approved-nonpersonal
node --env-file-if-exists=.env distribution/cli.js publish-skill infrastructure-reference 1.0.0 --approved-nonpersonal
node --env-file-if-exists=.env distribution/cli.js list
node --env-file-if-exists=.env distribution/cli.js get <record-digest>
node --env-file-if-exists=.env distribution/cli.js adopt-knowledge <record-digest> reviewed-terrain none
node --env-file-if-exists=.env distribution/cli.js adopt-skill <record-digest>
node --env-file-if-exists=.env distribution/cli.js relay <record-digest> --approved-nonpersonal
node --env-file-if-exists=.env distribution/cli.js withdraw <record-digest>
node --env-file-if-exists=.env distribution/cli.js adoptions
```

These are individual examples, not an automatic approval pipeline. Knowledge
adoption requires a chosen local source and expected current revision (`none` for
a new source). The adopted revision is `peer-<record-digest>`; the persistent
adoption ledger links that local revision to the record, origin and immediate
sender. Existing local knowledge cannot be overwritten without this explicit
compare-and-swap. Skill adoption only publishes a registry candidate; locally
evaluate and explicitly activate it using `skills/cli.js` afterward. Foreign
receipts, permissions outside shipped profiles and remote activation are rejected.
Adoption journals an intent before local publication and supports idempotent retry
across the two stores; it is not a cross-database atomic transaction.
An intent's target/expected revision is immutable. If another local edit makes a
pending intent stale, adopt under a freshly reviewed local source rather than
silently retargeting or overwriting it. Precondition failures detected before
intent creation do not consume an adoption slot.

Imports are never automatically relayed. `relay` requires a separate local review;
it preserves original bytes/origin. `withdraw` stops serving this node's copy and
rotates its feed epoch; it cannot erase another node's retained copy or undo a
previous local adoption. Retire local knowledge or deactivate skills separately.
`list [AFTER_DIGEST]` returns 20 metadata entries plus a cursor; `get` shows text
only in the local administrative CLI. `adoptions` returns the latest 20 intents/
receipts. CLI failures are fixed codes with no raw payload/platform details.

For Docker development, run from the root, for example:

```powershell
docker compose -f compose.yaml -f compose.dev.yaml exec -T fracto-dev node servers/fracto-ai-server/distribution/cli.js status
```

Use the service OS identity. The CLI never generates a new identity implicitly.
Existing private AI peer storage persists `peers/distribution`; no new volume or
dependency is needed. Native/custom peer directories follow `peers/README.md`.

## Bounds and recovery

Scoped pulls start automatically after enrollment: four-entry pages, at most four
192 KiB records per turn, a 30-second turn deadline, existing five-second request
deadlines/rate limits, and 30-second polling with bounded backoff to five minutes.
Status, artifact and distribution work share the existing single peer worker;
delegation retains its existing separate bounded worker. Publication changes and
withdrawal are read on the next turn without restarting the service.

Each peer/type has a durable cursor, checkpointed per accepted/known/rejected
record; interrupted pulls resume. Old feed epochs/cursors require resnapshot.
Malformed records, hash mismatches and origin conflicts have bounded metadata-only
quarantine; malformed pages do not advance a cursor. Storage/capacity failures
preserve the cursor and retry later. Candidate receipt never schedules inference,
activates a skill, changes a live dataset or grants a new action.

SQLite schema 1 uses private ACLs/POSIX 0700/0600, FULL synchronization, DELETE
journaling, a 2-second busy timeout and a 128 MiB default-page-size cap. Writes
require 1 GiB free disk. At most 1000 records and 1000 adoption intents persist;
quarantine retains 100 fixed-code metadata rows. No seven-day expiry or automatic
candidate deletion applies. Capacity exhaustion rejects new imports/publications
rather than deleting knowledge. Withdrawn records retain provenance locally.
Unknown schemas, symlinks and corrupt referenced records fail closed. Failure of
this optional catalog preserves ordinary peer/Fracto health and local operations.

Stop peer/CLI writers before backing up the entire private peer directory;
preserve identity for the same installation only, and keep knowledge/registry
backups consistent with pending adoptions. Restored cursors may require resnapshot;
review activation separately. No two-node lab validation is implied by synthetic
tests; that deployment step remains paused.
