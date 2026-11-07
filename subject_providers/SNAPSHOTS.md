# Complete local bundle snapshots

Step 5 separates reconciliation (staging) from publication for future bundle
readers. Publication is local to the knowledge store. It does not distribute
anything to peers, select a skill, enable chat retrieval or add startup behavior.
The later [automatic refresh lifecycle](REFRESH.md) now invokes staging and
publication together under persistent ownership guards.

Reconciliation retains the complete validated artifact, including every declared
document, in one immutable `bundle_artifacts` row alongside the existing manifest
history. Source selections and provider ownership continue to follow step 4's
local override rules. A staging manifest can therefore describe documents that
were skipped in the source library; it is not automatically a published snapshot.

## Local workflow

From the Fracto root under the service identity and storage environment:

```powershell
npm run knowledge:bundle
npm run knowledge:reconcile
npm run knowledge:bundle:status
npm run knowledge:bundle:publish -- NEW_BUNDLE_DIGEST none
npm run knowledge:bundle:publication
npm run knowledge:bundle:read
```

Replace `NEW_BUNDLE_DIGEST` with the digest reported by reconciliation. `none`
means no previous publication. On replacement supply the current publication's
digest as the second argument. The provider is fixed to `ui-features` in the CLI.
Equivalent AI-directory commands are:

```powershell
node knowledge/cli.js bundle-publish NEW_BUNDLE_DIGEST EXPECTED_PUBLISHED_DIGEST
node knowledge/cli.js bundle-publication
node knowledge/cli.js bundle-read
node knowledge/cli.js bundle-read HISTORICAL_BUNDLE_DIGEST
```

`bundle-publication` returns publication time, digest and document metadata;
`bundle-read` returns the complete artifact, including document text, for local
administration. Both open SQLite read-only and need no source checkout, UI
dependencies, artifact file, network or model. An explicit historical digest
reads retained history even if it is no longer published or an operator retired
its sources, matching existing explicit historical knowledge reads. Historical
access is not a way for normal retrieval to bypass current publication disable.
`bundle-status` still describes the staging head and additionally reports the
publication pointer and its disabled flag, without document text.

## Publication and reader contract

`publish_bundle(provider, digest, expected)` takes the same SQLite writer lock as
reconciliation and operator edits. It verifies:

- The expected publication digest matches the current pointer, including a
  disabled pointer. New publications use `null` internally (`none` in the CLI).
- The selected digest is the latest reconciled staging head and a complete,
  integrity-validated artifact is retained under that provider and digest.
- Every declared source has matching provider/document ownership, revision,
  non-retired state, no operator override, and verified stored text/digest equal
  to the artifact. A skipped declared document blocks the whole publication.

Only then does one transaction set the publication pointer and time. A missing or
corrupt document, source collision, override, stale expectation, disk admission
failure or SQL error leaves the previous pointer unchanged. Retiring a removed
document during staging does not change the old published artifact: the old
generation remains complete until a new complete publication is selected.
Previously published snapshots cannot be selected as rollback through this API;
a reviewed new staging snapshot can intentionally contain prior content.

`published_bundle(provider)` uses a single SQL statement joining the pointer,
complete artifact and manifest. It validates the entire bounded artifact and
returns detached `{published_at, bundle}` data. Consumers must call it once per
operation and use that returned bundle for all documents and citations. They
must not combine its manifest with independent current-source queries or call it
again midway through an operation. The captured object remains one generation
even if another connection publishes, reconciles, edits or retires sources later.
It is a point-in-time read, not cancellation of already-running operations.

Successful public knowledge `put` or `retire` on a provider-owned source marks its
override and disables that provider's publication in the same transaction.
Subsequent published reads fail `BUNDLE_PUBLICATION_DISABLED`. Even an identical
manual put is an explicit ownership change. The disable is conservatively
provider-wide, including owned sources omitted from the current publication.
No historical artifact or previously captured object is rewritten. New publication
must pass all checks; reconciliation never clears operator overrides. A reviewed
new declaration can omit an overridden document and publish its remaining complete
set. Failed manual writes do not disable anything.

## Persistence, migration and bounds

Schema 3 adds `bundle_artifacts` and `bundle_publications` transactionally to
schemas 1/2; current schema 4 adds refresh ownership. Read-only clients support
all four without migration. Old schema-2
manifests are not proof that all desired document bytes were retained, so migration
does not fabricate artifacts or publications. Reconcile the intended trusted
artifact again to materialize its complete body, then explicitly publish it.
Previously non-current schema-2 manifests remain history and cannot be replayed.

Artifacts are immutable, canonical UTF-8 JSON bounded to 4 MiB each, with the same
64 KiB/document and provider output bounds. They share the existing 64 MiB SQLite
page cap and 1000-snapshot/64-provider limits. Complete bodies duplicate retained
document text intentionally so publication does not depend on mutable source
selections or skipped imports; this can reach the database cap before 1000
snapshots. Capacity failure rolls back staging rather than pruning history.
New bodies/publication pointers require 1 GiB free disk. Identical reconciliation
and publication replays leave database bytes, ingestion/publication times and
document revisions unchanged and require no new disk admission.

Stored artifacts are revalidated against their digest, provider and retained
manifest on every read/publication/replay. Corrupt existing content fails closed
rather than being silently repaired. SQL publication and staging are crash-atomic
under the existing FULL-synchronization and rollback-journal configuration.
Back up the whole knowledge directory with writers stopped before upgrading;
older binaries reject schema 3. Existing content-file durability/recovery and
Windows directory-fsync limits still apply.

Fixed errors include `BUNDLE_PUBLICATION_CONFLICT`,
`BUNDLE_PUBLICATION_INCOMPLETE`, `BUNDLE_PUBLICATION_NOT_FOUND`,
`BUNDLE_PUBLICATION_DISABLED`, `BUNDLE_SNAPSHOT_NOT_FOUND`,
`CORRUPT_BUNDLE_SNAPSHOT`, `INVALID_BUNDLE_DIGEST` and the existing stale/disk
errors. No paths, source text or parser details are included in errors.

`npm run test:knowledge-publication` checks complete generations across
connections/reopening, immutable pinned reads, unchanged publication bytes/times,
removal, conflicts/overrides, late staging and pointer failures, corruption,
schema-2 migration and the actual generated seven-document artifact through the
local CLI. Tests use disposable stores and do not alter a running deployment.
