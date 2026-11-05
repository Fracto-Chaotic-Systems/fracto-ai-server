# Fracto AI server

Independent Node >=22.19 / Express service at `servers/fracto-ai-server/`. This is
the foundation for Fracto's future operations coordinator and AI game director.
The phased implementation plan is [ROADMAP.md](ROADMAP.md).
The next implementation sequence is [FIRST_STAGE.md](FIRST_STAGE.md): native
Windows, Ollama first, independent local engines and authenticated peer sharing.
Ollama's common adapter is implemented. llama.cpp, vLLM and SGLang are registered
as unavailable until their adapters are implemented. Model execution stays on
one node per request. See [the adapter contract](engines/README.md).

## Current stage

Persistent local reference knowledge is implemented in [knowledge/README.md](knowledge/README.md):
explicit local document import, immutable revisions/provenance, SQLite full-text
search and source retirement. Startup initializes it independently of inference;
the existing private AI volume retains it. `GET /knowledge/status` returns only
allowlisted counts/availability. Document contents are local CLI-only and are not
sent to inference or peers. The first [infrastructure reference skill](infrastructure/README.md)
answers local questions with bounded, exact source passages and verifiable citations.
It is extractive retrieval, requires no model, and does not inspect live systems
or execute actions. Startup idempotently seeds four reviewed infrastructure
references; retired or locally managed sources remain under local control.
The [versioned skill registry](skills/README.md) now persists immutable definitions,
examples, evaluation cases and receipts. Only an evaluated, explicitly active
release can run through the local skill CLI; startup bootstraps the shipped
infrastructure release once and preserves later selections/deactivation.
Registered procedures are inert data, with execution restricted to shipped
read-only handlers. Model synthesis remains later work.

The [environment/asset data-quality skill](data_quality/README.md) scans approved
local snapshots for duplicate/missing/ambiguous references and content patterns.
It reports complete counts with bounded details and non-applied, version-pinned
deduplication proposals. It opens no live database or model, and follows the
registry's evaluation, activation and disable gates. Live corrections remain later work.

Controlled corrections are implemented for explicitly registered local snapshot
datasets in the [data service](../fracto-data-server/corrections/README.md), with
independent validation, explicit approval, atomic audit and version-checked rollback.
The AI CLI exports a selected proposal only; its skill retains read-only permissions.
Existing live MySQL tables still require a defined owner mapping before corrections.

[Peer distribution](distribution/README.md) now shares explicitly reviewed
knowledge revisions and immutable skill definitions under separate directional
scopes. Automatic pulls retain untrusted candidates only; local adoption is
explicit, and skill evaluation/activation remains local. Imported content is not
automatically relayed. Credentials, model weights, corrections, approvals and
live datasets are excluded. `GET /distribution/status` reports only counts.

Process health, Windows host startup benchmarking and local Ollama engine
provisioning, the adapter, and bounded local inference with SQLite persistence
are implemented. Machine callers can submit fixed aggregate-only performance
assessments; regular Fracto workflows do not submit inference automatically.
Fracto compute-campaign scheduling remains planned. Peer identity provisioning,
explicit certificate trust, scoped mutual-TLS connections and automatic probes
are implemented; see [peer connections](peers/README.md) for enrollment and rotation.
Scoped artifact sharing is implemented in [exchange/README.md](exchange/README.md):
retained approved local results publish automatically, authenticated peers pull
validated artifacts/metadata with durable cursors, and imports remain untrusted
evidence. Status-only enrollment shares no artifacts. Explicit whole-request
delegation is implemented in [delegation/README.md](delegation/README.md), with
required model digest, single-hop execution, durable receipts and reconciliation
of ambiguous outcomes. It requires a separate directional `inference:delegate` grant.
Ordinary Fracto readiness requires no peers, model, GPU, database connection or
working inference store. The legacy
health `stage` and empty `capabilities` remain unchanged for compatibility; use
engine and authenticated inference status to inspect those capabilities.
Supported Windows Fracto launchers automatically collect inventory and a
post-readiness baseline; see [BENCHMARKS.md](BENCHMARKS.md). No operator command
or model is needed. Collection failures do not affect application readiness.
Windows startup also provisions and runs the pinned local Ollama engine through
an independent controller; see [OLLAMA.md](OLLAMA.md). Its local API is installed,
and the Ollama adapter can inspect it without loading a model. A selected local
model is still required for generation; no model is installed or selected by
startup. See [local inference](inference/README.md) for APIs, authorization,
bounds, recovery, deployment, retention and backup instructions.

| Endpoint             | Behavior                                                                                      |
| -------------------- | --------------------------------------------------------------------------------------------- |
| `GET /`              | Health response; compatible with ordinary Fracto service probes                               |
| `GET /healthz`       | Process liveness, HTTP 200                                                                    |
| `GET /readyz`        | Foundation readiness, HTTP 200                                                                |
| `GET /engine/status` | Versioned engine capabilities/availability; engine failure never changes foundation readiness |
| `/inference/*`       | Separate machine-token-authorized submission/status/result/cancellation                       |
| `GET /peers/status`  | Aggregate peer availability/counts; no identities, endpoints or credentials                   |
| `GET /knowledge/status` | Local store availability and counts; no document content or source labels |
| `GET /skills/status` | Registry availability and counts; no definitions, examples or questions |
| `GET /distribution/status` | Candidate catalog availability and counts; no text or identities |

Health responses contain only `contract_version`, `service`, `status`, `stage`,
`capabilities`, and `uptime_seconds`, with `Cache-Control: no-store`. Unknown
paths and unsupported operations return a generic JSON 404. These read-only
health endpoints are public. `/engine/status` is also public and reports only
allowlisted operational counts, flags and states; it excludes model names,
prompts, outputs, URLs and provider error messages. Inference requires a separate
generated local machine token, independent of browser sessions or lab bypass.
It accepts numeric aggregates and returns enumerated advisory output. Both nginx
examples keep inference private to local machine callers.

## Run and build

From this directory: `npm ci`, `npm run check`, then `npm start`. Use `npm run dev`
for Node watch mode. From the Fracto root, the supported full-stack entry point
is `npm start`; an isolated supervised launch is
`node scripts/launch_service.js fracto-ai-server`.

Persist the native installation's model selection in this repository's ignored
`.env`, for example `FRACTO_AI_MODEL=qwen2.5:7b-instruct-q4_K_M`. `npm start`,
`npm run dev` and the root service launcher load this file when present; inherited
process environment values take precedence. Missing `.env` remains supported.
Direct `node index.js` does not load it; use `node --env-file-if-exists=.env index.js`.
For Compose deployments, set the same model tag in the Fracto root's ignored
`.env`; Compose forwards it to the service. Keep engine URL defaults unchanged:
native uses loopback and Compose uses the explicitly enabled host gateway.
Neither saved selection downloads a model. Restart/recreate the service after
changing it. These files are local configuration and are excluded from Git/images.

`FRACTO_AI_PORT` selects a TCP port (1–65535), default 3007; development Compose
sets 3107. Native listening defaults to loopback; Compose explicitly binds all
container interfaces and publishes the AI port on host loopback. Both nginx
examples map `/api/ai/` to this listener while blocking inference. stdout/stderr are captured
by the supervisor in dated `logs/fracto-ai-server-log-YYYY-MM-DD.txt` files;
the root log API accepts `service=ai`. SIGINT/SIGTERM close the listener.

The separate peer TLS port is 3447 natively/in production, 3547 in development
Compose. Default host publication is loopback; intended lab interfaces and trust
are explicit local configuration. It has no root port-discovery entry and is
not exposed through nginx. Empty trust allows no peer operations. Peer failures
do not change HTTP readiness. SIGINT/SIGTERM also stop probes and peer sockets.

The root Dockerfile installs this service's locked dependencies, runs its
checks in the build stage, and includes it in production and development.
Port discovery, preflight, readiness, repository updates, build revisions,
Admin status/Reference/Commits, and coordinated milestone tags include it.
Health is local to this process; it does not imply any future AI capability
or fleet dependency is available.

## Files and ownership

- `app.js`: side-effect-free app factory, health contract, port validation.
- `knowledge/`: durable curated documents, provenance, full-text index, local CLI and startup lifecycle.
- `infrastructure/`: read-only reference skill, cited passages and reviewed startup references.
- `skills/`: immutable skill releases, evaluation/activation and allowlisted local dispatch.
- `data_quality/`: bounded environment/asset snapshot scans, findings and correction proposals.
- `distribution/`: scoped peer publication, candidate imports and explicit local adoption.
- `index.js`: listener startup and bounded shutdown.
- `app.test.js`: HTTP contract, no identity echo, unsupported actions, port validation.
- `package.json` / `package-lock.json`: independent scripts and locked dependencies.
- `ROADMAP.md`: scope, boundaries, staged deliverables and acceptance criteria.
- `FIRST_STAGE.md`: Ollama-first Windows deployment, resource baselines, local
  persistence, peer artifact exchange and whole-request delegation plan.
- `benchmark_windows.ps1` and `BENCHMARKS.md`: repeatable local Windows capacity
  and responsiveness measurements for step 1; results stay in ignored runtime storage.
- `startup_observer.js`: process-generation detection, duplicate suppression,
  cancellation and bounded retry policy, with pure lifecycle tests.
- `startup_benchmark.js`: Windows host observer, PowerShell collector invocation,
  atomic status, completed-report checks and bounded report retention.
- `ollama_release.json`: pinned official Windows package version and checksum.
- `install_ollama_windows.ps1`: idempotent verified standalone installation.
- `start_ollama_windows.ps1` and `ollama_windows.js`: hidden independent engine
  controller and nonblocking Windows bootstrap; `ollama_windows.test.js` covers
  platform selection, failure isolation and release metadata.
- `OLLAMA.md`: native installation, runtime configuration, ownership and validation scope.
- `engines/`: common adapter contract, Ollama implementation, registered future
  backends, bounded transport and schema validation. `engines.test.js` exercises
  the protocol against a synthetic local HTTP engine without loading a model.
- `inference/`: durable queue, SQLite, protected local credentials, atomic
  artifacts, admission and machine-only APIs. `inference.test.js` covers lifecycle,
  recovery, privacy and resource failures without loading a model.
- `check_syntax.js`: checks service, adapter, inference, peer, exchange and delegation JavaScript before tests.
- `peers/`: protected identity/enrollment, certificate allowlist, mTLS listener,
  bounded status client, automatic reload/probing, aggregate status and local
  administration CLI. `peers.test.js` tests real TLS and trust lifecycle.
- `exchange/`: independent durable artifact catalog, publication/validation,
  resumable scoped pulls, relay deduplication, inventory/profile metadata,
  retention/resnapshot and authenticated local inspection. `exchange.test.js`
  tests synthetic generation-to-import and failure/recovery boundaries.
- `delegation/`: explicit selected-peer inference, scoped local/peer APIs, model
  digest guards, durable origin receipts, one-hop admission, cancellation and
  unknown-outcome reconciliation. `delegation.test.js` covers real TLS and failures.
- `.env.example`: non-secret native adapter configuration with the selected development model as an example; copying it does not download a model.
- `.gitignore`: local dependencies, credentials and future runtime artifacts.
- `LICENSE`: the license from the repository's initial commit, preserved.
- `.github/workflows/validate.yml`: independent Node 22 validation on pushes and pull requests.

This folder is an independent Git checkout, not part of the root repository.
Keep it directly under `servers/`. Commit its source here; commit supervisor,
Docker, Compose and shared integration changes in the root checkout, and Admin/UI
changes in their respective repositories. Follow the root PROJECT_GUIDELINES.md,
especially its prohibition on personal information crossing APIs.

For initial repository publication, create the remote as `fracto-ai-server`,
publish this source, and configure a tracking branch before ordinary `npm start`.
The root prestart updater intentionally rejects missing upstreams, uncommitted
tracked changes, and divergent branches. An empty remote is not a deployable
service release. Existing installations must check out this sixth service and
update Admin and the root together before rebuilding.
