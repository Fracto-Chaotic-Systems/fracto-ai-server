# AI server implementation plan

Status: stage 0 foundation implemented; stages 1–5 are planned.
Windows host inventory and post-readiness baseline collection now run
automatically through the standard Fracto startup workflows. This is the first
deployment increment, not completion of the broader fleet-monitoring stage.
Pinned Windows-local Ollama installation, independent startup and the common
engine adapter are implemented. Model selection and real-model generation
benchmarks remain pending; see OLLAMA.md and engines/README.md. A machine-authorized
local inference queue and SQLite persistence are implemented in inference/README.md.
This is a bounded advisory prototype; distributed job scheduling remains later work.

Explicit peer trust and bounded mutual-TLS status connections are now implemented
in peers/README.md, including unattended identity creation and automatic probing
after administrative enrollment. Scoped artifact/metadata pulls are implemented
in exchange/README.md with independent durable catalogs, verified canonical content,
resumable cursors, relay deduplication, retention and resnapshot. Imported material
remains untrusted evidence. Explicit whole-request delegation now runs through
delegation/README.md: one selected peer, required digest/profile, one-hop local
execution and durable reconciliation without automatic resubmission. Broad compute
campaign scheduling and game actions remain later work;
actual lab-node enrollment and artifact grants remain deployment-specific.

The next deployment increment is [FIRST_STAGE.md](FIRST_STAGE.md): Ollama-first
inference on independent Windows nodes with 48 GB and 64 GB RAM, followed by
authenticated exchange of inference artifacts and whole-request delegation.
This brings forward the inference adapter prototype; the broader stage 1–5
operations/game deliverables below remain planned.

## Purpose and boundaries

Initially coordinate high-volume jobs, monitor server performance, and synchronize
operational data across many Fracto installations. Later support an AI game
director, potentially the main source of world events and decisions.

The service has two conceptual layers: a deterministic operations coordinator
and an optional AI advisor/planner. Jobs, health checks, retry limits and data
integrity must keep working without model inference. AI proposals pass through
typed, allowlisted actions with explicit authorization and ordinary validation.
Do not give the model arbitrary SQL, shell access, credentials or filesystem access.

Existing services retain ownership: data owns persistent records, tiles owns
numerical access and its mesh inventory, assets owns rendering/publication,
and the root supervisor owns local process lifecycle. This service coordinates
those boundaries rather than replacing them. A provider-neutral model adapter
will support Ollama, llama.cpp, vLLM and SGLang eventually, beginning with Ollama.
Each AI node owns a complete local engine and inference store and operates
independently of peers. Nodes may exchange approved inference artifacts or
delegate whole requests; model execution must never be split across hosts.
The initial deployment is native Windows; GPU availability and the baseline
model must be established by measurement. See FIRST_STAGE.md for the accepted
deployment decisions and implementation sequence.

## Stage 0 — Repository and build foundation (implemented)

Create an independent Node/Express service with a lockfile, health endpoints,
graceful shutdown, tests, this plan, and standard Fracto lifecycle integration.
Use ports 3007/3107 without moving existing services. Include the service in
runtime discovery, logs, readiness, Docker dependency installation/checks,
development mounts, repository management and administrative service listings.

Acceptance: standalone health works with no model/database credentials; unknown
actions return 404; health exposes only fixed operational fields; the root build
and service registries recognize it. No future capability is reported as ready.

## Stage 1 — Read-only fleet observations

Define versioned operational schemas and installation/capability registration.
Collect continuous service health, CPU/memory/disk utilization, event-loop delay,
request latency distributions, job throughput/failure counts, oldest queued job
age, and dataset/build versions. Record observation time and distinguish stale
observations from healthy state. Establish bounded history and deterministic
alerts before adding model-generated explanations. Keep network addresses in
protected deployment configuration rather than telemetry/model payloads.

Introduce scoped, revocable machine credentials with private transport and
per-action permissions. Existing supervisor-local shared tokens are not a fleet
identity/authorization design. Use explicit field allowlists for all success,
error and telemetry paths; personal information is prohibited even on internal
APIs. Never send complete logs, sessions, requests or arbitrary records to a model.

Acceptance: observe two installations; detect service unresponsiveness and stale
telemetry; bound storage/cardinality; demonstrate no personal fields or secrets
cross the new APIs. Monitoring works while inference is unavailable.

## Stage 2 — Durable unattended jobs

Start with one authoritative data-service job store and one worker task family.
Evaluate extending the existing MySQL automation table before adding a broker;
measure claim contention and throughput. Current transactional claims and
checkpoints are a foundation, but do not provide leases or stale-worker fencing.

Add bounded batches, capability/data-locality scheduling, priorities, admission
limits, attempt records, retry/backoff limits, cancellation and dead-letter
inspection. Claims need expiring ownership, heartbeats, and monotonically
advancing ownership versions; completion/publication must reject expired owners.
Design for at-least-once execution with duplicate-safe effects and checkpoints.
Do not promise exactly-once execution across storage and network boundaries.

Extract browser-dependent Tiles operation execution into server-side adapters;
the current mounted Navigator/render-completion path cannot run unattended.
Keep CPU work in isolated workers and preserve interactive-service capacity.
Persist plans/checkpoints/results outside memory; queue payloads reference large
artifacts rather than carrying large arrays or binaries.

Acceptance: a two-machine campaign survives worker/coordinator restarts, repeated
delivery and lost acknowledgments; expired owners cannot publish; cancellation
and retry limits work; queues and memory remain bounded. Benchmark representative
jobs and protect interactive latency before increasing fleet size.

## Stage 3 — Verified synchronization and publication

Inventory each data domain's authority, version and deletion policy first.
Use manifest/checksum-based, resumable transfers for numerical tiles, compiled
indexes, meshes and rendered assets. Match dataset identity and build profile;
transfer only missing/changed content, validate before atomic activation, and
retain an explicit rollback path. Never scan the entire authoritative corpus
on every monitoring cycle or synchronize live writable directories blindly.

Preserve one mesh inventory owner per volume. Remote workers produce staged
artifacts that the owning service validates and publishes, or use independent
stores with controlled imports. Multi-host writers to today's mesh volume are
unsupported. Existing atomic local writes alone do not solve distributed ownership.

Keep one authoritative job database initially. For editorial/world data use
versioned updates and conflict checks; general multi-master database merging is
out of scope. Define partition behavior: disconnected workers may finish work
within valid ownership rules, but cannot assume new authority. Publication after
reconnection must revalidate ownership and source versions. Add controller
backup/restore and, later, fenced leader failover if availability warrants it.

Acceptance: interrupted transfers resume, corrupt/version-mismatched artifacts
are rejected, duplicate publication is harmless, stale workers cannot activate
results, partition/rejoin is safe, and an accepted release can be rolled back.

## Stage 4 — AI operational advisor, then bounded actions

Add a provider-neutral inference interface with timeouts, concurrency/token/cost
budgets, model/version recording, bounded operational context, and structured
outputs. Begin with explanations and proposed job plans. Validate every proposed
action against schemas, resource budgets, permissions and current observations.
Treat log/model text as untrusted input, never as authority to execute commands.

Introduce narrowly scoped automatic actions only after offline evaluations and
shadow runs. Record the observation, proposal, validation and action outcome
without personal data. Include a disable switch and deterministic fallback.
Require explicit operational policy for impactful actions such as cancelling
campaigns, activating releases or changing resource allocations.

Acceptance: malformed, unauthorized, stale and over-budget proposals are rejected;
model outages do not halt scheduled work; evaluation fixtures reproduce decisions;
operators can inspect decisions and disable model actions.

## Stage 5 — Game director

First define authoritative world state, a durable event history, versioned game
actions and simulation invariants. Build lore/quest/encounter/faction proposals on
those contracts. Give game inference separate credentials, context, queues and
resource budgets from infrastructure operations. World decisions must never grant
server-administration powers.

Apply AI decisions through game-rule validation and state-version checks; retain
event causality, replayable accepted actions and deterministic fallback behavior.
Keep frame rendering, movement and collision independent of model latency.
Advance from authored content assistance to event direction, then broader world
agency only as game design and evaluations justify it.

Acceptance: one bounded world-event scenario works with model failure and stale
proposals; invalid game actions cannot mutate state; accepted events can be
replayed; game activity cannot starve operations or access administrative tools.

## First operational milestone and sizing

Target one mesh-generation campaign across two machines, restarting a worker
mid-run, publishing through one inventory owner, and producing an operational
performance summary. This exercises the central risks before broad autonomy.

Before committing to capacity, measure jobs/minute, job durations and memory,
artifact sizes, bandwidth, machine count, latency targets and retention. Plan
roughly 1–2 engineer-weeks for read-only monitoring/diagnosis, another 3–5 for one
durable distributed task family, and another 4–8 for synchronization and hardening.
These are preliminary estimates for one experienced engineer and a small fleet,
not commitments. A game-director prototype needs a defined game-state/action
contract before its scope can be estimated reliably.
