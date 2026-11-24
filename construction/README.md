# Construction planner v1

The [representative evaluation](EVALUATION.md) records eight fixture builds,
six failure cases, renderer/MySQL fidelity checks, catalog gaps and live-model
results. The earlier latency failure is historical: plain-floor and reviewed
wooded-path gates now pass; broader creative model quality remains unmeasured.

This folder owns proposal-only local construction planning. It never applies or
saves a component, changes catalog metadata, executes generated code, or publishes
artifacts. `contracts.js` bounds requests/model output; `prompts.js` builds compact
scene/catalog context; `catalog.js` owns authenticated read-only asset HTTP calls;
`translate.js` maps model aliases to real pinned references and shared commands;
`planner.js` orchestrates retrieval/generation/revalidation; `http.js` registers
the machine-only endpoint. `browser.js` exposes the dedicated stage capability
with origin/session authorization. Inference admission remains in `inference/service.js`.

`evaluation.js` owns scripted scoring; `live_evaluation.js` owns live baseline
and calibration gates. `client.js` is the shared local machine caller for planning
and evaluation executables; it never opens a second store or exports credentials.

The stage conversation/preview/apply bridge is implemented in the UI. Existing
read-only registry skills are unchanged; this is a dedicated reviewed server
capability, not a model-supplied skill or dynamic tool installer.

## Machine API

The dedicated browser API is `POST /construction/plan`, exposed as
`/api/component-construction/plan` by UI/nginx. It uses the identical bounded
planner body and proposal/error contracts below, with trusted mutation origin
and existing enabled-session authorization before parsing. It neither needs nor
issues an AI machine token. No browser headers/session data enter planning.
It admits six burst requests, refilling one per ten seconds without per-user/IP
tracking. Disconnect propagates cancellation. See the UI's
`src/pages/games/COMPONENT_CONVERSATION.md` for preview/apply ownership.
`construction/browser.test.js` covers auth-before-parse, request/rate bounds,
fixed error mapping and real HTTP disconnect cancellation.

`POST /inference/construction/plan` accepts JSON with exactly:

```json
{
  "contract_version": 1,
  "brief": "Propose a plain 4 by 12 meter floor.",
  "document": "<full validated component document object>"
}
```

Replace the illustrative document string with a v1 SDK document. Authentication
is the existing `X-Fracto-AI-Token` machine credential; Origin/Cookie requests
are rejected before parsing. No query parameters, model/provider/schema overrides,
caller-selected recipes, URLs, personal profiles or arbitrary tool calls are
accepted. The body limit is 1 MiB; brief limit is 1,000 characters / 2,048 UTF-8
bytes. The response is `Cache-Control: no-store` and is not a durable job.

Optional `guidance` extends the v1 request compatibly: up to three exact
`{kind:"preference"|"recipe",instructions:"..."}` records, each at most 1,000
characters and together at most 2,400 serialized UTF-8 bytes. The shared SDK
rejects extra fields, including local IDs or profile metadata. It is construction
data, not a caller-supplied server recipe, schema, tool or permission. Both model
calls receive it beneath the current brief's precedence and existing tool/limit
constraints. The AI never stores a pattern library or infers new preferences.
The UI owns explicit browser-local persistence, scope matching and controls;
see its games/COMPONENT_MEMORY.md. Old callers can omit guidance unchanged.

Successful responses include `contract_version:1`, `planner_version`, a server
UUID `proposal_id`, `applied:false`, `base:{document_id,document_hash}`, `status`,
`recipe`, `summary`, `questions`, `assumptions`, `commands`, `information_needed`,
`catalog_matches`, `catalog_limited`, `scene_limited` and `preview`.
Status is `proposal`, `needs_information` or `no_changes`. Missing materials or
calibration produce explicit gaps; a needs-information response can contain a
partial valid batch for review. Preview includes the resulting document hash,
floor presence, object/scatter counts and total instances. Hashes are SHA-256 of
SDK `component_document_json` canonical JSON, including the entire document.
Commands conform to `FractoComponentTools.js`; the API does not return or save
a modified document. Future callers must compare the base hash to the current
draft, re-resolve pins and independently preview the whole batch before Apply.
A repeated request is a fresh proposal, with new IDs; there is no idempotency
record, automatic retry, delegation or fallback provider.

Errors return `{error:"CODE"}`: 400 invalid request, 401 unauthorized, 413 body
or context limit, 429 rate limit/engine busy, 409 changed catalog/cancellation,
502 invalid model output/plan or engine protocol, 503 unavailable planner,
catalog, configured model or resource headroom, and 504 engine deadline.
Disconnect aborts planning; shutdown awaits cancellation. Planning shares the
single local inference admission slot with chat and queued jobs, the existing
memory/disk checks, and a 175-second deadline. It never relaxes engine limits.

## Planning flow and bounds

1. Validate the complete document and brief. Build a compact scene summary with
   at most four object and two scatter target aliases. Unseen targets cannot be
   edited. `scene_limited` signals omitted targets.
2. Ask the configured local engine for at most four short catalog keyword
   queries and one reviewed recipe: none, wooded-path-v1, ground-cover-v1 or dense-grass-strip-v1.
3. Read the asset service's existing material search API, four results per query,
   and resolve a compact best-candidate set by exact revision (bounded by the
   query count, at most four). Distinct query roles are represented before
   alternatives; `catalog_limited` signals omitted ready candidates.
   Asset HTTP uses authenticated loopback `FRACTO_ASSET_PORT` (default 3003),
   rejects redirects, has 15-second read limits and 256 KiB response limits.
   Only approved material facts are projected; provenance is excluded.
4. Ask for at most eight abstract actions, plus bounded questions/assumptions.
   Eligible new wooded scenes instead extract bounded count/floor/corridor and
   height/scale parameters, then compile the [reviewed recipe](WOODED_PATH.md)
   into one floor and three seeded scatters. Explicit constraints are honored or
   clarified with no partial edits; automatic scale choices are disclosed.
   Each action has an exact required-field schema; neutral/textured floors,
   placement, transform, removal and scatter have separate bounded alternatives.
   Empty stages expose no meaningless floor cleanup or unseen edit targets.
   Compact serialized messages fit 7,800 bytes; candidates are dropped to fit.
   No material facts are inferred. Outputs obey the engine's supported JSON
   schema subset; server translation also enforces each action's exact fields.
5. Replace model aliases with actual asset IDs/revisions, registered texture
   paths, existing target IDs or fresh server UUIDs. Re-resolve every used pin.
   Replay the whole batch with the shared SDK, including footprint clearance,
   frozen seeded scatter, 1,000 total instances and 64 distinct pins. Invalid
   output, stale references or impossible layouts fail without partial apply.

Built-in recipes are reviewed server source, distinct from explicitly remembered
instructions or registered dynamic skills. Catalog prose is untrusted context. Current instructions take
precedence; missing requested materials should produce questions, not invented
assets. Model quality still requires scene-based evaluation; validation guarantees
contract and tool constraints, not that the arrangement meets every creative brief.

The [dense grass strip recipe](DENSE_GRASS_STRIP.md) saves the reviewed 809-patch
yard_grass_motion cover over dry_dirt. Eligible empty stages extract dimensions
and compile the saved transforms into a floor plus one bounded SDK place-pattern
command. Uniform scaled copies are supported; changed pins, incompatible sizes
or extra constraints require clarification. The normal preview/Apply/undo path
expands it into editable objects. Run `--live --grass-strip --write --summary`
to evaluate this exact natural-language requirement against the live model.

## Local verification

Successful proposals now include allowlisted numeric `timings_ms`: retrieval and
construction elapsed/load/input/output durations and token counts, plus total
planner time. Missing provider measurements remain null. No model IDs, prompts,
thinking or raw provider records are included. The local CLI summary reports
phase elapsed times; evaluation reports retain the numeric breakdown.

Empty scenes without usable materials use a shorter prompt and a floor/clear-floor
schema without placement/scatter fields. Missing materials still require explicit
gaps, and plain floors are proposed only when requested. The independent shared
tool validation and catalog checks remain unchanged.

`--live --plain-floor --write --summary` on `construction:evaluate` runs only the
plain-floor gate and preserves the earlier full-run evidence in a separate
`runtime/construction-evaluation-plain-floor.json` report. This run includes HTTP
and final model cleanup time; planner phase timings exclude that final cleanup.

`node --test construction.test.js` exercises proposal/replay, catalog projection,
stale pins, missing calibration, malicious/invalid actions, HTTP authorization,
exclusive inference admission and cancellation with synthetic generation.

`npm run construction:plan -- --input request.json` calls the running local AI
server with its existing protected credential; optional `--summary` prints only
counts/status. `npm run construction:plan -- --smoke --summary` constructs a
temporary document and checks a real-model plain 4 × 12 m floor proposal.
Neither command saves a component, applies commands or changes model selection.
Run inside the Compose container when its private credential/model configuration
is in use. No browser receives the machine token.

Verification on 2026-11-23: synthetic planner/HTTP and component tool/document
tests pass. NVMe model storage and integrated-GPU discovery resolved the original
plain-floor timeout; measured first-load costs remain host-dependent. All eleven
vegetation/dirt assets are calibrated. The reviewed wooded-path proposal now
passes exact counts, full-footprint corridor clearance and floor bounds in the
live evaluation. See [EVALUATION.md](EVALUATION.md) for results and remaining model
composition work. No evaluation proposal was applied or saved as a component.
