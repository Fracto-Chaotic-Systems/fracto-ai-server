# Persistent local knowledge

This folder owns curated reference documents and SQLite FTS5 search, independent
of inference, Ollama, MySQL and peer exchange. `storage.js` owns transactions,
immutable revisions, content files and search; `runtime.js` owns startup/shutdown
and directory selection; `cli.js` provides local administration. Documents are
evidence, never executable instructions or permissions.

## Local workflow

Run from the AI service directory as the service's operating-system identity:

```powershell
node --env-file-if-exists=.env knowledge/cli.js status
node --env-file-if-exists=.env knowledge/cli.js list
node --env-file-if-exists=.env knowledge/cli.js put terrain-contract revision-1 approved-reference.md
node --env-file-if-exists=.env knowledge/cli.js search "terrain mesh"
node --env-file-if-exists=.env knowledge/cli.js get terrain-contract
node --env-file-if-exists=.env knowledge/cli.js put terrain-contract revision-2 updated-reference.md revision-1
node --env-file-if-exists=.env knowledge/cli.js get terrain-contract revision-1
node --env-file-if-exists=.env knowledge/cli.js retire terrain-contract revision-2
node --env-file-if-exists=.env knowledge/cli.js reconcile
node --env-file-if-exists=.env knowledge/cli.js bundle-status
```

`put SOURCE REVISION FILE [EXPECTED_CURRENT_REVISION]` reads one explicitly
selected UTF-8 text/Markdown file, at most 64 KiB. Source/revision are logical
non-personal labels (lowercase letters, digits and hyphens, at most 80 characters),
not paths, people or network locations. Use a traceable source revision label.
Review and sanitize documents before import: exclude secrets, personal data,
complete logs and private configuration. There is no crawling or URL fetching,
nor a claim that text is automatically certified free of personal information.
No text is sent to a model, HTTP API, telemetry, root logs or peers. CLI output
is for local administration only.

`reconcile` explicitly adopts the fixed generated UI bundle in one transaction,
with durable provider ownership, immutable manifest snapshots and preservation of
operator edits/retirements. `bundle-status` reads its selected manifest without
writing. `bundle-publish DIGEST EXPECTED_PUBLISHED_DIGEST` separately selects a
complete snapshot (`none` for the first publication). `bundle-publication` reads
its metadata; `bundle-read [DIGEST]` reads the whole published/historical artifact.
See [complete snapshots](../subject_providers/SNAPSHOTS.md) and
[bundle reconciliation](../subject_providers/RECONCILIATION.md) for
admission, removal/restoration, replay, capacity and deployment behavior. No skill
or chat activation is performed by these manual commands. [Automatic refresh](../subject_providers/REFRESH.md)
now consumes prepared bundles on startup and every minute under persistent
ownership guards; disable it with `FRACTO_AI_APP_REFERENCE_REFRESH=false`.

`list [AFTER_SOURCE]` returns up to 20 current-source metadata records (including
retired sources) and a `next_cursor`; supply it to retrieve the next page.
For Docker development, run the same commands in the existing service container:

```powershell
docker compose -f compose.yaml -f compose.dev.yaml exec -T fracto-dev node servers/fracto-ai-server/knowledge/cli.js status
```

Container `put` paths must refer to an explicitly approved file visible inside
that container. Do not copy the host's native database into the Compose store.

Every revision retains source/revision, SHA-256 digest, byte size and ingestion
time. Source/revision pairs are immutable; different bytes conflict. Identical
imports are idempotent. Updating requires the expected current revision, so stale
writers cannot silently replace newer knowledge. Retired sources remain readable
but leave search; restoring requires a new revision and the last current revision
as expectation. Supplied provenance is not independently verified attestation.

Search ANDs up to eight literal Unicode word tokens and returns at most ten ranked
500-character excerpts with source, revision, digest and chunk number. FTS syntax
is not accepted. Only current non-retired revisions are searched. Bounded
2000-character chunks with 200-character overlap index source text, retained in hashed
files. Search is lexical, not semantic or proof of truth. Retirement controls
stale sources; automatic source monitoring, embeddings, general skill execution and
automatic replication into active local knowledge are later steps. Explicit
reviewed publication and candidate-only peer distribution now live in `distribution/`;
local adoption requires a chosen source and expected revision. The local `infrastructure/` reference skill
retrieves exact cited passages; no inference operation consumes this library.
Its four explicitly bundled reviewed documents seed during standard AI startup,
with immutable digest revisions and respect for explicit retirement/local edits.

## Storage and recovery

Startup initializes `<FRACTO_AI_DATA_DIR>/knowledge`; native default is ignored
`runtime/knowledge`. Existing private production/dev Compose AI volumes persist
it without new mounts/dependencies. `FRACTO_AI_KNOWLEDGE_DIR` optionally selects a
dedicated native/CLI directory. Docker refuses source-mounted fallback without
an explicit data directory. Never share a SQLite directory across machines.

The existing protected-directory ACL helper (via `peers/files.js`) restricts
Windows access; POSIX directories/files are 0700/0600. SQLite schema version 4
uses DELETE rollback journaling, FULL synchronization and a 2-second busy timeout.
Writable opens transactionally migrate versions 1/2/3 without removing knowledge;
read-only opens support all four versions. Earlier binaries reject version 4.
Short transactions permit CLI access while the service runs.
The infrastructure question CLI uses SQLite read-only mode and a consistent read
snapshot, without ACL changes, initialization, orphan cleanup or document writes.
Unknown schemas, symlinks and corrupt requested documents fail closed. Initialization failure
disables only knowledge, preserving Fracto health and inference. CLI errors are
fixed codes without raw paths/platform details.

At most 1000 revisions persist, each at most 64 KiB; index page count is limited
to 64 MiB (with default 4 KiB pages), and imports require 1 GiB free disk.
Knowledge does not inherit inference's seven-day retention. Capacity exhaustion
rejects imports rather than deleting knowledge. Content is fsynced and atomically
published before database commit and verified on read. Initialization removes
only unreferenced hash-named content files left by interrupted imports, serialized
with writers. Windows directory fsync is unavailable in Node; power-loss guarantees
depend on SQLite/filesystem behavior. No online backup is implemented.

Stop the AI service and CLI writers before copying the whole directory for backup;
preserve restrictive permissions. Restore to dedicated local storage and verify
retained documents and representative searches. Never reset a damaged or
unknown-schema store merely to make readiness succeed.

`../knowledge.test.js` covers persistence, revision conflicts, concurrent
connections, current/retired search, invalid input, tampering, disk admission,
runtime isolation and orphan recovery.
`../knowledge_reconcile.test.js` covers transactional bundle import, ownership,
local overrides, snapshot history, migration and generated-artifact CLI adoption.
`../knowledge_publication.test.js` covers complete snapshot publication, reader
pinning, compare-and-swap conflicts, disabled publications and failure recovery.
