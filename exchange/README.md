# Inference artifact exchange

This folder owns the independent durable exchange catalog and scoped, bounded
artifact pulls. Imported records are immutable untrusted evidence, separate from
local jobs. Importing never schedules inference, changes models or executes actions.

`contracts.js` defines canonical allowlisted records/manifests; `storage.js` owns
SQLite, artifacts, receipts, cursors and retention; `sync.js` resumes scoped pulls;
`local.js` publishes completed local jobs; `metadata.js` bounds engine/profile
metadata. The peer runtime owns their lifecycle under its protected data directory.
`artifacts.js` owns atomic content files, `runtime.js` schedules collection and
synchronization, and `http.js` adds inspection behind existing machine authorization.

## What is shared

Only successful `assess_performance` jobs using template/schema/profile version 1
are published. The canonical artifact contains contract version, original logical
node UUID, origin epoch and sequence, operation, request/completion timestamps,
five approved numeric input aggregates, enumerated output and allowlisted model/
engine/profile/usage/timing provenance. Job IDs, idempotency keys, model names,
prompts, raw generated text/thinking, URLs, paths, credentials, logs and identifying
user/device data are excluded. Validation applies at publication, import and read.

Each origin assigns an increasing sequence within a persistent random origin epoch.
Records are immutable and content-addressed by SHA-256. Relays preserve their exact
canonical bytes and origin tuple while using their own catalog feed sequence.
Duplicate origin/content is harmless; conflicting content under a retained origin
tuple is quarantined without replacing the accepted record. Returned records that
claim this installation's own origin are never adopted as new local history.

**Imported records are untrusted evidence.** mTLS authenticates the immediate sender;
hashes detect corruption and schema checks limit content. They do not prove the
truth of an assessment or independently attest a relayed origin. Origins are
provenance claims, not signatures. Local inspection labels records
`untrusted_evidence` and identifies the immediate logical sender separately.
Do not use imported material as authority, instructions or automatic cache hits.
There is no shared conversation/KV state, model weight transfer, cross-host engine
execution, automatic result reuse or operational action in this module. Explicit
delegation is a separate authorized path in ../delegation/README.md; sharing data
never invokes it.

Metadata also exchanges a bounded installed-model inventory (at most 16 unique
digests/sizes, excluding model names), numeric engine version and the fixed inference
profile. Missing/offline engines produce explicit unavailable metadata. Collection
uses metadata-only adapter calls, never model pulls, generation or warm-up. Snapshots
are advisory and can be stale/truncated; they do not establish delegation readiness.

## Enrollment and automatic behavior

No new service port, npm dependency or database service is required. This feature
uses the existing peer TLS listener and the protected AI volume. Upgrade both ends
before enabling exchange; the old step-5 status client required `artifacts:false`.
Do not run it in an older container that lacks the explicit protected data directory:
rebuild/recreate through the normal startup pipeline as documented in ../peers.

Existing status-only enrollment grants no artifact access. On each installation
deliberately grant `artifacts:exchange` in the relevant directions, using the existing
verified certificate bundle and fingerprint. For bidirectional status and sharing:

```text
node peers/cli.js enroll <bundle.json> https://<approved-peer>:3447 <verified-fingerprint> status:read,artifacts:exchange status:read,artifacts:exchange
```

Inbound scope permits that certificate to read this catalog/metadata; outbound
scope permits pulling its catalog. The other installation independently controls
its grants. Authorized peers can relay approved records to their own authorized
peers; there is no per-record recipient or relay restriction in this protocol.
`inference:delegate` authorizes the separate whole-request protocol, never artifact
inspection or imported-result execution. There is no discovery, artifact HTTP push,
arbitrary file reader or remote change to the local inference queue.

After grants reload, sharing runs automatically without per-job commands. Each
five-second peer poll projects up to four retained completed local jobs into the
catalog. Source jobs are marked locally by private publication receipts, preventing
republishing after restart or catalog retention while those jobs remain available.
Source collection is bounded, not an unbounded outbox: jobs pruned by the inference
store before collection cannot be exported. This prototype does not guarantee
complete archival at generation rates above its collection/retention capacity.

Status and exchange choose the oldest due work across peers, with one outbound
peer task at a time. One exchange pass per peer reads metadata, one manifest page
and only missing blobs. A successful pass becomes eligible after 30 seconds;
failures back off to at most five minutes. Many peers increase intervals. Revocation
or invalid configuration aborts current transfers and withdraws access through
the existing five-second trust reload; it does not delete previously imported data.
Status distinguishes pending/catching-up peers from peers whose last page reached
the end of the advertised feed; a completed page alone is not full synchronization.

## Peer protocol and recovery

All routes require mTLS and `artifacts:exchange`; GET only, fixed Host, no browser
credentials, request bodies, query strings, redirects or request-selected URLs.

| Peer route                                   | Response                                                       |
| -------------------------------------------- | -------------------------------------------------------------- |
| `/peer/v1/artifacts/metadata`                | Bounded inventory and version-1 profile                        |
| `/peer/v1/artifacts/manifest/start/0`        | Begin/resnapshot a catalog, at most four entries               |
| `/peer/v1/artifacts/manifest/:epoch/:cursor` | Next bounded page of that catalog                              |
| `/peer/v1/artifacts/blob/:digest`            | Exact canonical JSON for an advertised retained SHA-256 digest |

A manifest carries catalog epoch, requested cursor, next cursor, more flag and
entries containing feed sequence, hash, byte count and stable origin tuple. Each
entry must increase the feed cursor and fit the supported contract. Blobs are at
most 8192 bytes. Imports verify exact size, SHA-256, UTF-8, schema, provenance and
canonical encoding before atomic publication; duplicate JSON keys, hidden text,
extra fields, unknown versions/profiles and arbitrary prose are rejected.

Files publish by exclusive temporary write, file fsync and atomic same-directory
publication before a SQLite transaction commits the record **and** its peer cursor.
The cursor advances after each accepted/duplicate/ignored entry, not only at page
end. An interrupted request retries from the last committed record; an individual
small blob restarts from its beginning, without a byte-range protocol. Orphan files
left before a database commit are removed at recovery. No partial result is exposed.

Catalog pruning changes its random catalog epoch. Epoch mismatch, a cursor beyond
the feed head (including restoration of older history), or a blob removed between
manifest and download causes a bounded resnapshot from `start/0`. Already retained
content deduplicates; missing records on a peer are not deletion instructions.

Malformed/conflicting records enter a **metadata-only quarantine**: source logical
UUID, fixed rejection code and local time, limited to 100 entries. Rejected payloads
are discarded, never written to quarantine files or returned by diagnostics.
Validated feed entries with rejected content advance the cursor so one bad record
does not block the rest. Invalid manifests do not advance it. Ordinary transport
failures/cancellation/disk pressure preserve progress for retry. A malformed producer
must publish a corrected new immutable record; rejected history is not automatically
trusted or executed on a later run.

## Storage, bounds and inspection

`<peer-data-directory>/exchange/` contains its own version-1 `exchange.sqlite` and
`artifacts/`. It is independent of inference SQLite and MySQL; no shared/network
database file is used. The inference database's earlier reserved `peer_cursors`
table remains unused. Exchange SQLite holds settings/epochs, records, private local
publication receipts, per-peer cursors/inventories and bounded quarantine metadata.

Use one owner per dedicated directory. SQLite uses exclusive ownership, DELETE
rollback journaling, `synchronous=FULL`, transactional schema initialization and
8192 maximum pages (normally 32 MiB). Unknown schemas/corruption fail closed.
Windows directory ACLs and POSIX 0700/0600 permissions follow peer-store protection.
POSIX publication fsyncs its directory; Node cannot do so on Windows, so durability
remains subject to filesystem guarantees. Recovery validates all referenced hashes
and schemas and never silently replaces a damaged catalog with an empty one.

Retain at most 1000 records and seven days from local acquisition, with independent
local pruning. An imported record can reappear after pruning during a later
resnapshot; there are no distributed tombstones. Local publication receipts remain
while their source jobs are retained. Cursors/inventory snapshots cover only the
at-most-16 configured peers; removed peers' local cursors/inventories are pruned.
Imported files are at most 8 KiB, so retained payloads are at most about 8 MiB plus
SQLite and transient files. Disk admission requires 1 GiB free before publishing
or importing. Pressure pauses new records; it does not change local inference
or process readiness. Failed exchange storage disables exchange, preserving files
for recovery; peer status and ordinary Fracto remain available.

Network limits retain existing TLS/header/connection/rate bounds. Each request
has a five-second total deadline and an 8 KiB maximum response for exchange routes;
a complete exchange pass has a 30-second deadline. Engine inventory refresh is at
most once a minute, using one-second metadata requests. No model is loaded by this.

Authenticated local inspection uses the existing `X-Fracto-AI-Token`, separate from
peer certificates. It remains behind `/inference` and nginx's inference block:

| Local route                                        | Behavior                                                    |
| -------------------------------------------------- | ----------------------------------------------------------- |
| `GET /inference/artifacts/status`                  | Catalog/source availability and aggregate counts            |
| `GET /inference/artifacts/manifest/:epoch/:cursor` | Same bounded catalog view                                   |
| `GET /inference/artifacts/blob/:digest`            | Artifact plus untrusted-evidence label and immediate sender |
| `GET /inference/artifacts/metadata`                | Own current bounded inventory/profile                       |
| `GET /inference/artifacts/inventories`             | Validated retained peer snapshots with acquisition times    |

Public `/peers/status` adds only sanitized aggregate exchange counts/state and an
artifact capability flag. It exposes no records, node IDs, hashes, inventory,
endpoints, credentials or rejected content. HTTP `/readyz` stays independent.
Local inspection needs a working local machine credential; peer exchange itself
can operate with the inference service/database unavailable. Imported records are
never inserted into `jobs`, selected as generation context, or submitted to Ollama.

For backup, stop the service and copy the whole protected peer/exchange directory
alongside the node identity, preserving permissions. Restore to the same stopped
logical installation; never run two owners or clones. Reconcile peer revocations
and origin history when restoring older backups: an old origin sequence can
conflict with already distributed history and will be quarantined. Do not reset
or reapply a schema to clear this automatically; preserve evidence and explicitly
plan a new origin epoch/store if needed. Private backups must never be peer artifacts.

`../exchange.test.js` verifies automatic job publication and real mTLS import,
machine authorization, partial-page restart, duplicate/relay-loop suppression,
hash/schema/privacy rejection, cancellation, retention/resnapshot, disk pressure,
failed publication, corruption and continued local inference with peers stopped.
Tests use synthetic approved numeric fixtures, not installed-model generations or
the actual 48/64 GB lab machines. Those installations still need deployment,
enrollment, artifact scopes and real-model performance measurements.
