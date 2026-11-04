# First deployment stage: independent Windows nodes with Ollama

Status: automatic Windows startup baseline collection is implemented; the
Ollama engine installation/startup, common adapter and bounded local persistence
and authenticated peer connections/artifact sharing/explicit delegation are implemented;
model provisioning and the
remaining deployment/inference steps are planned. This follows the completed
foundation milestone and brings forward a small inference prototype before the
broader operations and game capabilities in ROADMAP.md.

## Accepted direction

- Support Ollama, llama.cpp, vLLM and SGLang through interchangeable adapters
  eventually. Implement Ollama first; report the other adapters as unavailable
  until implemented and tested. A node need not install all four engines.
- Initial lab machines are ordinary Windows systems with 48 GB and 64 GB RAM.
  GPU models and VRAM are unknown. Establish a CPU-capable baseline and inventory
  acceleration before relying on it. System RAM does not establish GPU capacity
  or interactive inference speed.
- Each AI node owns its complete local engine, models, configuration and durable
  inference store. It can perform local inference without peers, a central AI
  coordinator, MySQL, or the other Fracto services.
- Nodes exchange permitted inference records and can explicitly delegate a
  complete inference request to another node. Every request executes on one node.
  Do not split model layers, tensors, experts, KV caches or decoding across hosts.
- Shared inference data initially means validated request/result artifacts and
  their provenance, model/profile metadata and bounded operational summaries.
  It does not mean shared RAM, live conversations, replicated databases, model
  training, automatic weight merging, or automatic model-file distribution.

## 1. Establish a Windows deployment and resource baseline

Use `benchmark_windows.ps1` following [BENCHMARKS.md](BENCHMARKS.md) to collect
comparable local reports. Both target lab machines still require measurement;
the connected workspace host reports about 32 GB RAM and is not either target.
Normal Windows Fracto launches now perform this collection automatically:
inventory, stable-readiness settling, then passive baseline samples. Operators
do not run manual benchmark commands or supply machine labels for this pipeline.

Inventory CPU/core count, RAM, available RAM under normal Fracto load, GPU/VRAM,
free disk and Windows version on both machines. Keep identifying host/device
details in local administration; export only allowlisted non-personal capacity
aggregates. Measure existing Fracto responsiveness before introducing inference.

Run the Node AI service and Ollama natively for this first Windows deployment.
Keep Docker integration working for the existing stack, but do not require GPU
passthrough, WSL or a Linux inference stack to use the prototype. The existing
root launcher remains a supported integration path. Add a documented standalone
AI installation/startup path outside the full-stack preflight, since that preflight
requires unrelated services, a tile index and MySQL. Do not weaken its checks.

Acceptance: the same service can start alone, and also participate in the full
Fracto supervisor. Its own dependencies and data locations are explicit.

## 2. Provision one complete local Ollama instance

Engine installation and independent controller startup are implemented in
[OLLAMA.md](OLLAMA.md), using the official pinned Windows standalone package.
Model selection/download and cold/warm generation benchmarks are not yet done.

Install a tested Ollama Windows release and select a protected local model
directory with sufficient disk space. Configure local-only operation
(`OLLAMA_NO_CLOUD=1`), bind the engine to loopback, and select one model at a time.
Record engine version and model digest; use controlled upgrades and warm-up
checks rather than assuming an automatically updated engine remains compatible.
Automate engine startup through the standard Fracto startup pipeline, with an
independent hidden controller. No separate Windows boot task is required by this
increment; before-login execution follows any existing Fracto service deployment.
Document restart behavior and ownership of the background process.
Avoid running both the tray application and another server on the same
port. The Fracto supervisor probes the engine but does not terminate an
independently managed Ollama instance when the AI service stops.

Start evaluation with a small instruction model in roughly the 4–8B parameter
range, using a supported four-bit quantization. This is a sizing experiment,
not a selected model or performance promise. Benchmark the same model/profile
on both machines before selecting and recording the baseline model and license.

Proposed conservative starting profile, subject to measurements:

| Setting                  | Initial policy                                                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Loaded models            | One                                                                                                                    |
| Simultaneous generations | One per node                                                                                                           |
| Context                  | Approximately 4K tokens                                                                                                |
| Output                   | At most 512–1024 tokens per request                                                                                    |
| Pending requests         | Bounded, initially 16                                                                                                  |
| Inference timeout        | Configurable; initially 180 seconds, then tune from CPU measurements                                                   |
| RAM                      | Target a small runtime footprint, initially around 12–16 GiB or less; admit work only with measured OS/Fracto headroom |
| CPU                      | Benchmark a limited thread budget and leave capacity for interactive Fracto services                                   |

These are admission and test targets, not a claim that Ollama provides a hard
RAM limit. Observe actual memory use and stop admitting new inference when the
configured headroom floor is breached. Total installed RAM is not the available
inference budget. Do not automatically choose a larger model for the 64 GB host.

Acceptance: warm and cold local generations complete on each machine with cloud
features disabled; memory and latency are recorded alongside Fracto responsiveness.

## 3. Define the engine adapter and implement Ollama

Implemented: [engines/README.md](engines/README.md) defines the common contract,
Ollama implementation and public read-only `/engine/status` response. Generation,
schema validation, warm-up, cancellation and deadline behavior are tested against
a synthetic local engine. Real Ollama metadata/inventory and the same-host Docker
Desktop transport are verified without loading a model. Real-model generation
benchmarks remain pending model selection and resource admission.

Define an engine-neutral contract for health, model inventory, generation with
optional JSON schema, cancellation/deadline handling and normalized usage/timings.
Keep provider-specific fields and transport inside the adapter. Capability flags
must distinguish schema generation, streaming, cancellation and embeddings;
unsupported operations fail explicitly instead of being silently approximated.

Implement only the Ollama adapter now, using its local HTTP API. Keep the engine
URL in deployment-local configuration, not request-controlled input. Define the
future adapter identifiers `ollama`, `llama_cpp`, `vllm`, and `sglang`, with
Ollama as the first implemented backend. An HTTP API that looks compatible is
not proof of identical behavior; every later adapter must pass contract tests.

Separate process readiness from inference capability. Preserve the current
foundation health contract; add a versioned capability/status contract indicating
engine unavailable, model missing, warming, ready or busy. An engine outage must
not take down Fracto or prevent the AI node from serving peer synchronization.
No model pull should block ordinary root startup or run silently during a request.

Acceptance: generation works through the adapter; missing engine/model, timeout,
invalid schema output and cancellation have normalized, redacted outcomes.

## 4. Add bounded inference requests and local durable records

Implemented: [inference/README.md](inference/README.md) documents the machine-only
API, fixed aggregate performance-assessment operation, single generation/16
pending limit, resource floors, cancellation and shared queue/execution deadline.
Node's built-in SQLite stores durable jobs separately from MySQL; hashed artifacts,
protected auto-created credentials, retention and restart recovery are tested.
No model is selected or loaded by this increment. Peer cursors are reserved,
not synchronized yet. Real-model benchmarks and actual lab-node enrollment remain pending.

Create a small, versioned inference API: submit, inspect status/result, and
cancel. This is an inference request lifecycle, not the distributed mesh/job
scheduler planned later. Enforce bounded input size, context/output budgets,
queue capacity, concurrency and deadlines. Start with complete JSON responses
rather than streaming; add streaming once the basic contract is reliable.

Store inference metadata and peer cursors in a local SQLite database, with larger
permitted artifacts in a node-owned directory. Choose and test the Windows/Node
driver during implementation. No network-shared database file or central database
is required. Version the schema, document backup/restore, and implement retention,
disk-space checks and atomic artifact publication before enabling peer imports.

Record request ID, idempotency key, status, input artifact hash, model digest,
engine/version, prompt-template version, schema/profile version, sampling settings,
timestamps and validated output reference. Reject reuse of an idempotency key
with different content. After restart, mark interrupted generations explicitly;
never silently claim exactly-once inference or successful completion. A retry can
produce different text even with the same settings, so retain attempt provenance.

Only persist or transmit allowlisted non-personal operational/world content.
Do not expose a general raw prompt relay, forward logs wholesale, or attach
browser sessions, identities, credentials or device-identifying details. Structured
output still needs independent schema and application validation.

Acceptance: queue saturation is explicit; cancellation and restart recovery work;
completed results survive restart; the node works with peers and MySQL offline.

## 5. Establish explicit peer trust

Implemented: [peers/README.md](peers/README.md) describes automatic protected node
identity generation, an empty-by-default explicit certificate allowlist, a separate
TLS 1.3 mutual-authentication listener, independent directional scopes, bounded
automatic probes and live trust reload. Local commands enroll with an independently
verified fingerprint, revoke or rotate certificates. Real two-node TLS tests pass
on Windows and Linux. Actual lab endpoints/enrollment remain installation-specific;
there is no discovery or automatic trust. Artifact scope now enables the bounded
exchange in step 6; a separate delegation grant enables step 7. Local inference tokens grant no peer access.

Start with an administrator-configured peer allowlist on each node, not automatic
LAN discovery. Give installations generated non-personal node identifiers, and
keep peer network locations in protected local configuration. Authenticate peer
connections with scoped machine credentials over TLS, preferably mutual TLS.
Define separate permissions for status reads, artifact exchange and inference
delegation, with rotation/revocation and bounded connection/rate limits.

Keep Ollama's own listener private. Peers communicate with the Fracto AI API,
never directly with another machine's engine. Limit the authenticated peer
listener to the intended lab interfaces/firewall scope; do not expose new peer
operations through the existing public nginx route until authorization is in place.
Health may remain public, but inference and artifact endpoints may not inherit
the existing authentication-bypass behavior.

Acceptance: configured peers connect; unknown/revoked peers and wrong scopes are
rejected; a peer cannot redirect requests to arbitrary URLs or read local files.

## 6. Exchange validated inference artifacts

Implemented: [exchange/README.md](exchange/README.md) defines canonical approved
request/result records, digest-only inventory/profile metadata, four-entry manifest
pages, atomic imports and per-record durable cursors in independent exchange SQLite.
Origin tuples survive relays and suppress loops; conflicts/malformed content have
bounded metadata-only quarantine, and retention invalidates feed epochs for safe
resnapshot. Collection and scoped pulls are automatic after explicit grants.
Authenticated inspection labels imports untrusted; no cache reuse or action occurs.
Explicit delegation is separate in step 7. Windows/Linux tests cover real mTLS sharing, interrupted pulls,
restart, disk/corruption failures and local inference with the peer stopped. Actual
lab deployment, enrollment/scopes and real-model benchmarking remain pending.

Implement manifest-based pull synchronization with bounded pages, cursors and
content checksums. Transfer permitted missing artifacts, verify schema/size/hash,
then publish atomically. Repeated imports are harmless; interrupted transfers
resume. Imported data is untrusted evidence, never authority to execute actions.
Reject incompatible schemas and quarantine malformed/conflicting artifacts.

Give records stable origin IDs and origin sequence numbers, preserve provenance
through relays, and suppress loops. Define an epoch/resnapshot path when history
is pruned or a cursor is no longer valid. Keep local retention independent;
deleting a local copy must not delete the originating peer's data. In this stage,
artifacts are immutable and each origin owns its history; no multi-writer merge
of mutable records or shared inference memory is required.

Exchange model inventories and inference profiles as metadata. Install model
weights locally on each machine; automatic peer-to-peer model transfer can be a
separate future feature. Do not synchronize live KV caches or engine internals.

Acceptance: one node imports another's approved inference result, survives a
connection interruption and duplicate transfer, and can still infer independently.

## 7. Add controlled reuse and whole-request delegation

Explicit whole-request delegation is implemented in [delegation/README.md](delegation/README.md).
The caller selects one approved peer and required engine/model digest/profile.
The receiver admits to its existing bounded local queue, binds origin/idempotency
to the durable job, enforces a one-hop limit/deadline and executes on its own engine.
Origin receipts survive restart; submission uncertainty triggers same-peer status
reconciliation, never automatic generation retries, fan-out or fallback. Model
selection is checked at admission, dispatch and result validation. Tests include
real mTLS, lost acknowledgements, post-commit receiver failure, both-node restart,
cancellation, revocation, overload and malformed provenance. Actual lab deployment
and real-model measurements remain step 8. Imported-result inspection is implemented
in step 6; deliberate context reuse and exact-result caching remain deferred.

Make imported results available for inspection and, when explicitly allowed,
as context for a new local inference. Keep generated statements separate from
measured operational facts. Include observation age and source dataset versions.

Exact-result reuse requires a matching input hash, model digest, template/schema
versions, relevant generation settings and source-data versions, plus an explicit
freshness policy. Disable automatic cross-peer reuse initially; first demonstrate
inspection and deliberate reuse. An inference record is not a universal cache hit.

Permit explicit delegation of a complete request to one eligible trusted peer
that has its own complete engine/model. The receiver accepts or rejects admission
and records execution ownership. Carry origin request/idempotency IDs, remaining
deadline and a one-hop limit. Do not recursively forward, silently switch models,
or submit the same request to multiple peers after an ambiguous timeout. Resolve
status with the accepting peer before retrying or record the result as unknown.

Acceptance: a delegated request runs entirely on its accepting node; provenance
identifies the executor; busy/offline peers cause bounded failures; the originating
node can continue local work. Automatic load balancing is a later enhancement.

## 8. Prove the two-node milestone and document deployment

Use synthetic or explicitly approved non-personal fixtures: an operational
summary, a structured job-plan proposal and a small world-event proposal. Do not
execute the proposed job or game actions in this stage. Measure cold/warm latency,
tokens/second, schema validity, RAM/CPU, queue wait and effect on Fracto latency.
Set acceptance thresholds from these measurements before considering interactive
game use. CPU-only responses may be suitable for background work rather than
live conversation; establish that with measurements.

Run the following checks on both the 48 GB and 64 GB machines:

1. Local inference and artifact access with all peers disconnected.
2. Ollama unavailable, missing model, low memory/disk and a full queue.
3. AI service and engine restarts, cancellation and interrupted generation.
4. Authorized exchange, invalid credentials, malformed artifacts and version mismatch.
5. Interrupted/duplicate synchronization and explicit whole-request delegation.
6. No cross-host model execution, leaked personal fields or automatic tool actions.
7. Standalone Windows startup and existing full-stack build/start compatibility.

Deliver local configuration examples, Windows startup/recovery instructions,
resource profiles, peer enrollment/revocation, retention/backup instructions,
benchmarks and adapter contract tests. Keep live configuration and credentials
outside Git. Implement in small commits: adapter/local inference, persistence,
peer security, artifact exchange, then delegation and the two-node validation.

## Deferred work

Implement llama.cpp next as the alternative local backend, then evaluate vLLM
and SGLang on hardware/OS combinations they support. Keep their complete engines
on individual nodes under the same no-cross-host-splitting rule. Broad server
monitoring, durable Fracto compute campaigns, tile/mesh synchronization, autonomous
operational actions and game direction retain their later roadmap acceptance gates.
Local inference adds none of those capabilities by itself.

## Reference documentation

- [Ollama on Windows](https://docs.ollama.com/windows): native installation and model storage.
- [Ollama FAQ](https://docs.ollama.com/faq): local-only mode, concurrency and runtime configuration.
- [Ollama API](https://docs.ollama.com/api/introduction): local inference transport.
- [Structured outputs](https://docs.ollama.com/capabilities/structured-outputs): schema-constrained generation and response validation.
