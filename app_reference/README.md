# Read-only application reference skill

`app-reference/1.0.0` is a shipped Fracto registry release using the fixed
`app-reference-v1` executor and the sole permission `bundle:read`. This is an
application skill, not a Codex skill installation. It retrieves exact passages
from one complete published `ui-features` / `application-ui` snapshot.

## Bootstrap and use

Normal AI startup publishes/evaluates the shipped definition and selects it on
the first successful bootstrap, using the existing persistent registry. Later
startups preserve disable, rollback and local selections. Definition changes
require a new release; candidate publication alone never changes the active
selection. The registry's existing compare-and-swap and evaluation gates apply.

Evaluation uses disposable synthetic published bundles only. It never reads or
seeds deployed application knowledge. Registry bootstrap does not build, reconcile
or publish the live UI bundle. The separate [knowledge refresh lifecycle](../subject_providers/REFRESH.md)
now seeds prepared bundles on startup and refreshes them every minute by default.
The [manual snapshot workflow](../subject_providers/SNAPSHOTS.md) remains available
when refresh is disabled or operator selections require explicit handoff. An active skill without
a usable published snapshot fails explicitly rather than returning fabricated
reference evidence. No running deployment is restarted by the implementation tests.

After normal startup, from the AI directory using the service's storage environment:

```powershell
node --env-file-if-exists=.env skills/cli.js get app-reference 1.0.0
node --env-file-if-exists=.env skills/cli.js run app-reference approved-question.json
```

The input file contains only a question, for example:

```json
{"question":"Where is chat navigation?"}
```

`run` opens both registry and knowledge read-only and resolves the active,
currently evaluated release. No standalone bypass of activation is exposed by
the CLI. Missing stores are not initialized by a read command. Errors are fixed
codes: `READ_ONLY_REQUIRED`, `INVALID_SKILL_INPUT`, `APP_REFERENCE_UNAVAILABLE`,
and the existing question/registry errors. The app handler maps missing, staged-only,
disabled, corrupt or incompatible publications to `APP_REFERENCE_UNAVAILABLE`.
CLI infrastructure failures continue to use the existing redacted error envelope.

## Retrieval and citations

`reference.js` validates the bounded question and calls
`reader.published_bundle("ui-features")` exactly once per operation. All matching
and quoting uses that detached, validated snapshot. It never calls unscoped
knowledge search, current-source reads, historical snapshot fallback or a model.
Another writer can publish during dispatch without mixing generations. A later
operation sees the new publication; operator retirement/override disables future
published reads under the existing snapshot policy.

Retrieval is deterministic lexical matching with the existing question tokenizer,
stop words and small infrastructure alias set. It is not semantic inference or a
live check of routes, permissions or server availability. It scans the bounded
snapshot in 2000-character windows with 200-character overlap. Findings rank by
matched terms, document ID and chunk; at most five exact quotes of 600 characters
are returned. Input is at most 512 characters, 1024 UTF-8 bytes and 12 distinct
non-stop-word terms. Structural text and document instructions remain inert.

Each result includes `evidence_only: true`, `live_verified: false`, state,
unmatched terms and limits. Snapshot metadata includes provider, subject,
bundle/provider digests and publication time. Each finding cites document ID,
reserved knowledge source, immutable revision, document digest, chunk and exact
UTF-16 start/end offsets into the snapshot document. Registry dispatch additionally
attaches the selected release version, definition digest and executor fingerprint.
A valid snapshot with no lexical hits yields `insufficient_evidence`; unavailable
publication is an error. `evidence_found` indicates matching reference passages,
not proof that every question was fully answered.

## Evaluation and integration boundaries

`contracts.js` supplies strict fixed input/output schemas. The registry profile
requires the exact skill/executor/permission/schema combination and rejects mixed
capabilities. Candidate fixture sources must use the reserved UI provider prefix,
with valid document IDs; `mandatory` is reserved for evaluator-owned checks.
`fixtures.js` constructs synthetic complete bundles from approved reference text.
`evaluate.js` checks mandatory evidence/missing-evidence cases, release cases and
examples, one pinned read per call, exact snapshot citations and unchanged SQLite
bytes. Receipts bind definition and current code fingerprints. The fingerprint
includes app contracts, handler, fixtures/evaluation and publication validation
dependencies; code changes require reevaluation of the existing registry profiles.

The handler performs no inference, model context injection, network access, write
action or peer publication. [Chat integration](CHAT.md) now exposes an explicit
App reference mode through the existing authorized chat transport. Skill bootstrap
and bundle publication remain separate persistent selections. Automatic live
bundle refresh preserves operator overrides and the existing skill selection.

Run `npm run test:app-reference` from the Fracto root. Tests verify exact citations,
no unrelated-source leakage, concurrent publication pinning, unavailable and
disabled snapshots, input/permission bounds, inert instruction text, evaluation
gating, stale receipts, bootstrap persistence and the actual seven-document UI
artifact through the read-only registry CLI. All stores are disposable fixtures.
