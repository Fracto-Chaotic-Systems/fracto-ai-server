# Versioned application skill registry

This is Fracto's local application registry, not a Codex skill installer.
Definitions are immutable JSON releases containing a procedure, fixed input/output
schemas, permitted operations, examples and evaluation cases. Publishing stores a
candidate; it does not activate a version, install code or grant permissions.

`contracts.js` validates/canonicalizes definitions; `storage.js` owns SQLite
releases, evaluation receipts, active selections and bounded selection history;
`executor.js` is the fixed handler allowlist and code fingerprint; `evaluate.js`
checks mandatory and definition-supplied cases in isolated knowledge/snapshot fixtures;
`builtin.js` defines the initial infrastructure release, `data_quality/builtin.js`
defines the quality release, and `app_reference/builtin.js` defines the application
reference release; `runtime.js` installs all three
on startup; `cli.js` is local administration and dispatch. Registry text is inert.

## Lifecycle

Publication accepts the shipped `infrastructure-reference-v1` executor with
`knowledge:read`, `environment-asset-quality-v1` with `snapshot:read`, or
`app-reference-v1` with `bundle:read`. The [app-reference skill](../app_reference/README.md)
pins one complete published UI snapshot and returns exact document/bundle citations.
Skill IDs, executors, permissions and schemas must match the same fixed profile;
definitions cannot mix capabilities or weaken schemas.
Procedure text describes behavior; it does not alter handler code. Adding a new
capability still requires a reviewed server implementation, schemas and tests.
Candidate versions use numeric `MAJOR.MINOR.PATCH` labels. Identical publication
is idempotent; changing bytes under an existing skill/version conflicts. At most
1000 releases persist. There is no deletion or automatic expiry of releases.

Evaluation runs against disposable fixtures, never live knowledge, model engines,
peers or production records. It checks mandatory evidence/missing-evidence cases
for infrastructure/app reference and clean/duplicate-reference cases for data quality,
published cases and examples, input/output contracts, exact citations, result bounds, and no
database mutation. Receipts bind the definition digest and shipped executor code
fingerprint. Passing these checks establishes the shipped reference/scan behavior,
not general intelligence, document truth, or permission to perform actions.

Activation requires a passing receipt for the current code fingerprint and the
expected active version (`none` for no active selection). Deactivation and rollback
use the same compare-and-swap rule; rollback still needs current passing checks.
Execution resolves the active release, rechecks its receipt/code fingerprint,
validates input/output and dispatches only the allowlisted read-only handler.
Changing handler/contract/evaluation code invalidates old receipts until reevaluated.
Results include the registry version, definition digest and executor fingerprint.
The last 1000 activation/deactivation events are retained, without account/device IDs.

On startup, all three shipped releases are published/evaluated idempotently.
Only the first successful bootstrap of each skill selects it automatically. Later startups
preserve an explicitly disabled, rolled-back or locally selected release. Evaluation
is repeated only if its code fingerprint changes. Bootstrapping runs synthetic
retrieval and scan checks, not inference or the paused two-node validation. Failure disables
only this registry; ordinary Fracto health/inference/knowledge remain independent.
Local candidates require explicit evaluation/activation; publishing alone cannot
make the infrastructure CLI execute one.

## Local commands

Run from the AI service directory under the service's OS identity. These are
individual command examples, not a script to run sequentially:

```powershell
node --env-file-if-exists=.env skills/cli.js list
node --env-file-if-exists=.env skills/cli.js get infrastructure-reference 1.0.0
node --env-file-if-exists=.env skills/cli.js publish approved-skill.json
node --env-file-if-exists=.env skills/cli.js evaluate infrastructure-reference 1.0.0
node --env-file-if-exists=.env skills/cli.js activate infrastructure-reference 1.0.0 none
node --env-file-if-exists=.env skills/cli.js deactivate infrastructure-reference 1.0.0
node --env-file-if-exists=.env skills/cli.js history
node --env-file-if-exists=.env skills/cli.js run infrastructure-reference approved-input.json
node --env-file-if-exists=.env skills/cli.js run app-reference approved-question.json
```

Replace the final activation argument with the currently selected version when
switching releases. `get` exports the canonical definition and metadata for local
review; `publish` expects only the nested `definition` object, with a new version
for any edits, rather than the whole metadata response. `list [AFTER_SKILL]` pages
20 skill selections; `versions SKILL [AFTER_VERSION]`
pages 20 immutable releases (lexicographic version cursors, not upgrade order).
`history` returns the newest 20 selection events. The existing
`infrastructure/cli.js ask "terrain mesh storage"` now uses the active registry
release as well. If disabled or stale it fails rather than bypassing the registry.
The low-level JS retrieval function remains an internal implementation/test helper.

For Docker development, run from the Fracto root:

```powershell
docker compose -f compose.yaml -f compose.dev.yaml exec -T fracto-dev node servers/fracto-ai-server/skills/cli.js list
```

Startup initializes the registry before use. It needs no new
dependency, port or model. Definitions and fixtures must contain approved
non-personal reference data only. Input files are bounded local JSON; no network
fetching, dynamic imports, shell commands, arbitrary SQL or HTTP question endpoint
is added. CLI errors are fixed codes; definitions/results stay local and are not
sent to models, peers, telemetry or root logs.

## Persistence and recovery

The registry lives in `<FRACTO_AI_DATA_DIR>/skills` (native fallback ignored
`runtime/skills`). `FRACTO_AI_SKILL_DIR` selects a dedicated local native/CLI store.
Docker requires an explicit data directory. Existing private AI volumes persist
it independently of inference retention and knowledge documents. Windows ACLs use
the existing directory helper; POSIX directories/files use 0700/0600. SQLite schema
1 uses FULL synchronization, rollback journaling, a 2-second busy timeout and a
64 MiB default-page-size cap. New writes require 1 GiB free disk. Read commands
open read-only without initializing or changing ACLs. Unknown schemas, symlinks,
corrupt definitions and stale receipts fail closed. No reset/in-memory fallback.

Stop the AI service and registry writers before backing up the entire registry
directory with restrictive permissions. Back up knowledge separately. Restored
definitions/receipts are rechecked against current code before execution; the
registry does not restore a previous server executable. No multi-writer fleet
registry exists. Explicitly reviewed peer publication and
candidate-only imports now live in `distribution/`; adoption publishes a local
candidate without receipts/activation. Evaluate and activate on this node under
the usual gates. No code or write capability is installed by peer receipt.

`../skills.test.js` covers immutability, validation, evaluation gating, code drift,
selection races, disable/rollback persistence, startup bootstrap, local dispatch
and redacted aggregate status. Existing infrastructure/knowledge suites continue
to check exact citations and read-only behavior.
