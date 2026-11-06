# Automatic app-reference refresh and regression checks

The complete catalog-to-chat pipeline now refreshes automatically. Normal UI and
Docker builds generate the reviewed bundle. Vite development startup and relevant
source changes also regenerate it. AI knowledge startup consumes the fixed
prepared artifact immediately, then polls every 60 seconds. A fresh store needs
no manual import or publication before the app-reference skill can answer chat.
Skill bootstrap still uses its existing evaluation/selection lifecycle separately.

Set `FRACTO_AI_APP_REFERENCE_REFRESH=false` before startup to keep explicit manual
bundle publication. Both Compose profiles and the native example default to
`true`. Values must be the literal strings `true` or `false`; invalid configuration
disables refresh without disabling ordinary knowledge, health or inference.
Changing this environment setting requires restarting the AI process.

## Build and development refresh

The existing UI npm `prebuild` and Docker image preparation perform source drift
checks and publish one atomic generated artifact. Direct `vite build` bypasses
npm lifecycle hooks; use `npm run build` for production preparation.

`scripts/knowledge_bundle_plugin.js` runs only in the Vite development server. It
requests a build at startup and after UI JavaScript/TypeScript/JSON source changes,
catalog checker changes, or the fixed provider/generator input files change. Events
debounce for 300 ms; at most one child build runs, with one pending rebuild after
edits during a build. Each build launches the fixed root script in a fresh Node
process, preventing cached extractors from being paired with newer fingerprints.
It has a 30-second timeout, fixed executable/arguments, no shell, bounded captured
output and no model calls. Shutdown removes listeners and stops its child.

The watcher observes filenames; only the reviewed build driver admits source
contents. Dependencies, runtime/generated output, deployment secrets and arbitrary
checkout files are not build inputs. It does not infer new feature descriptions
from code. Maintainers still update/review the structured catalog when behavior
changes; registration drift fails generation until the catalog is corrected.
Failed builds retain the previous artifact and report a fixed development error.
The AI process never imports UI code, crawls sources or starts a build itself.

## Atomic storage refresh and operator ownership

`refresh.js` admits the complete fixed artifact and invokes
`KnowledgeStore.refresh_bundle`. One writer transaction performs reconciliation,
complete publication validation, pointer selection and refresh ownership update.
Readers see the complete old or new generation; chat pins one generation as before.
An invalid/missing/partial bundle, known stale build, disk/capacity error or late
publication failure rolls back staging, source selections and refresh ownership
together. The last good publication remains available unless an operator disabled
it through the existing override policy. Existing hash-file orphan recovery applies.

Schema 4 adds one `bundle_refresh` row per managed provider, recording the last
automatically selected digest. At first bootstrap, an empty store or an already
staged/published *identical* verified artifact may be adopted. Different existing
staging/publication selections are preserved as operator-owned. Subsequent refresh
can advance only while both staging and publication still match its recorded head
and publication is enabled. Manual source edits/retirements retain their overrides
and disable publication; refresh never clears them or activates a skill.

Manual staging or publication changes stop automatic advancement even when they
are complete and valid. To explicitly hand control back after reviewing and
publishing the intended bundle, use the local CLI from the AI directory:

```powershell
node knowledge/cli.js bundle-status
node knowledge/cli.js bundle-refresh-status
node knowledge/cli.js bundle-refresh-adopt PUBLISHED_DIGEST EXPECTED_MANAGED_DIGEST
```

Use `none` for an absent managed digest. The command compare-and-swaps refresh
ownership only after verifying the current published head, every declared source
and its immutable bytes under the ordinary publication gates. It does not change
publication, restore retired sources, clear overrides or start a poller itself.
A stale expectation fails `BUNDLE_REFRESH_CONFLICT`. A manually changed store
cannot be silently reclaimed on restart. Keep refresh false for permanent manual
control. A new reviewed declaration can omit an overridden source; explicit valid
publication and handoff are still required to resume after operator intervention.

Unchanged refreshes preserve database bytes, revisions, ingestion/publication
times and capacity. Code/artifact hashes have no chronology: known non-current
snapshots are rejected, but a never-seen older deployment cannot be recognized
as older from hashes alone. Deployment must supply the intended reviewed build.
There is no automatic pruning or reset when the existing limits are reached.

Writable stores migrate schemas 1–3 transactionally to 4; read-only access supports
all four. Migration preserves old data and does not fabricate refresh ownership.
Earlier binaries reject schema 4; back up the whole directory with writers stopped
before upgrading, and restore that backup for rollback to an older binary.

## Runtime lifecycle and inspection

The poller is unreferenced so it cannot keep shutdown alive; closing the knowledge
store stops it before closing SQLite. Missing bundles can recover on the next
poll after a valid build arrives. Refresh errors are isolated from the ordinary
knowledge store and public health/readiness. A fixed, content-free log appears
when refresh enters an unavailable state, without repeated logs every minute.
No question, reference text, path, credential, author or model data is logged.

Internal runtime status is `ready`, `unavailable`, `operator_override`, `disabled`
or `stopped`, with changed/digest/count metadata on success. The local
`bundle-status`, `bundle-publication` and `bundle-refresh-status` commands inspect
staging, selected snapshots and automatic ownership. Public knowledge/status
continues to expose only its existing allowlisted aggregate fields. No new HTTP
administration endpoint, remote watcher or peer replication is added.

## Regression gate

From the full Fracto checkout:

```powershell
npm run check:app-reference
```

This generates a fresh artifact, checks unchanged canonical output, then runs
provider, catalog, extraction, immutable storage/publication, refresh, skill,
chat, authorization, streaming and development-watcher regressions. All databases
are disposable fixtures; no live store or model is used. Focused refresh checks
are available as `npm run test:knowledge-refresh`.

Main, AI and UI validation workflows prepare the full sibling-repository layout
and root/AI/UI dependencies before these cross-repository checks. AI/UI workflows
use their triggering checkout for the repository under test; sibling repositories
come from their configured default branches, using the existing services-read
token policy. Coordinated cross-repository changes must therefore be released
together. CI does not treat missing UI dependencies or an absent generated artifact
as a successful full integration check.

Refresh regressions cover startup-to-chat without manual commands, periodic
content updates, stable repeats, restart/disabled-skill persistence, incomplete
artifacts, failure recovery, late transaction failures, operator edits/retirements,
manual selection/handoff, stale builds, removal/reintroduction, schema migration,
disk/capacity limits, configuration and shutdown. Watcher checks verify bounded
debouncing, serialized builds, input selection and child cleanup.
