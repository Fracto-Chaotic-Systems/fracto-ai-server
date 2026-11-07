# Persistent bundle reconciliation

Step 4 adds explicit local adoption of the complete generated UI bundle into the
existing knowledge store. It does not create or activate a skill, change chat
retrieval, run extraction at startup, invoke inference, or publish to peers.
The reconciliation API now participates in the separately guarded
[automatic refresh lifecycle](REFRESH.md), including startup consumption.
Step 5 now retains full artifacts and separately publishes complete generations;
see [complete snapshots](SNAPSHOTS.md). A reconciliation head is staging only.

From the Fracto root, using the service's storage configuration and OS identity:

```powershell
npm run knowledge:bundle
npm run knowledge:reconcile
npm run knowledge:bundle:status
npm run test:knowledge-reconcile
```

Generation requires the source checkout. Reconciliation requires only the AI
service, its shipped `subject_providers/ui.json`, and its generated
`generated/knowledge/ui-features.bundle.json`. It never reads the UI checkout or
installed UI dependencies. The generated artifact is build output under operator
control, not an upload or peer-adoption endpoint. Hashes establish integrity,
not factual truth or independent approval.

From the AI directory, equivalent commands are `node knowledge/cli.js reconcile`
and `node knowledge/cli.js bundle-status`. Load the same service environment
used by the running deployment; native defaults and `FRACTO_AI_KNOWLEDGE_DIR` /
`FRACTO_AI_DATA_DIR` selection follow the knowledge CLI. In Docker development:

```powershell
docker compose -f compose.yaml -f compose.dev.yaml exec -T fracto-dev node servers/fracto-ai-server/knowledge/cli.js reconcile
```

Generate the artifact in the mounted checkout first if a source bind hides the
image's build output. These commands are deployment instructions; tests use
isolated disposable storage and do not alter a running deployment.

## Admission and atomicity

`reconcile.js` reads only the fixed artifact and declaration, with regular-file,
link, strict UTF-8 and size checks (32 KiB declaration, 4 MiB bundle). It validates
all documents, hashes, revisions, provenance structure and the exact shipped
provider digest before opening the CLI store. Missing, partial, corrupt or
mismatched bundles fail closed; missing input never means retirement.

`KnowledgeStore.reconcile_bundle` validates/detaches the complete bundle and
applies document selections, source retirement, ownership, manifest history and
the provider head in one SQLite `BEGIN IMMEDIATE` transaction. Other connections
see the complete old or complete new state. Database commit failure rolls back
every selection; verified hash-named files written before failure may remain
unreferenced until the existing serialized startup cleanup. Historical document
revisions and their content files remain immutable and searchable selections
continue to use the existing FTS index.

The step-4 schema adds `bundle_snapshots`, `bundle_heads` and `bundle_documents`.
Current schema 4 also retains full artifacts, publication pointers and automatic
refresh ownership, migrating versions 1/2/3 transactionally while preserving
existing documents. Read-only access supports all four versions and never migrates.
Earlier server binaries reject
the new schema. Stop writers and back up the whole knowledge directory before a
deployment that upgrades an existing store. Restore that backup for an old binary;
do not change `user_version` manually.

## Selection rules

- A new source is imported only when its reserved ID is unoccupied. A preexisting
  source is skipped, even if its bytes or hash-shaped revision match the bundle.
- A source can update automatically only while its current revision and retirement
  state still match recorded provider ownership and it has no operator override.
- Public `put` and `retire` atomically record a lasting operator override on an
  owned source, including identical-content puts and retirement of an already
  retired source. Hash-shaped local revisions do not imply provider ownership.
  Reconciliation never resets an override; no automatic override-reset command
  is supplied in this step.
- A document omitted by a new, complete declaration retires only an unchanged,
  provider-owned source. History stays readable; retired text leaves search.
  A later complete snapshot can restore a provider retirement or select earlier
  content, using its existing immutable revision. Operator retirement wins.
- Identical documents retain revisions and ingestion times. Provenance-only
  changes create a manifest snapshot without duplicating document revisions.
  Replaying the selected bundle performs no database writes. A previously
  reconciled non-current bundle is rejected as `STALE_KNOWLEDGE_BUNDLE`.

Bundle hashes have no time order. A never-seen older artifact cannot be detected
as older from a hash; deployment must supply the intended reviewed build. A new
snapshot can be selected with skipped overrides/collisions: the stored manifest
records desired provider output, while the summary records what was applied.
Current source selections remain authoritative for ordinary knowledge search.
Published-bundle readers instead pin one complete immutable generation under the
separate publication contract.

## Bounds and inspection

The existing 1000-revision, 64 KiB-document, 64 MiB SQLite and 1 GiB free-disk
admission limits remain. There are at most 64 provider heads and 1000 immutable
bundle snapshots across providers. Capacity errors reject the complete import;
nothing is automatically deleted. An unchanged replay needs no new capacity or
disk admission. SQLite serialization protects against concurrent writers; source
overrides and reconciliation use the same transaction lock.

`reconcile` returns only provider/digest and counts: inserted, updated, unchanged,
retired and skipped, plus whether this is a replay. `bundle-status` opens
read-only and returns the selected manifest, first reconciliation time, original
summary and snapshot count. It includes approved logical paths and commit hashes,
not document text or credentials. Existing knowledge `get`, `list` and `search`
provide local inspection and exact historical citations. No new HTTP endpoint
or root log content is introduced.

`knowledge_reconcile.test.js` covers persistence, byte-identical database replays,
provenance/content history, local overrides across connections, removal/restoration,
stale snapshots, source collisions, schema migration, capacity/disk failures,
mid-import rollback, orphan recovery, artifact admission and the generated bundle
through the local CLI. Existing knowledge, infrastructure and skill suites verify
that their persistence, retrieval and lifecycle contracts continue to hold.
