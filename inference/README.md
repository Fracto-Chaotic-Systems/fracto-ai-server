# Local inference lifecycle

This folder owns machine-authorized inference, admission, durable queue state and
content-addressed artifacts. It never executes proposed operational actions.
`contracts.js` owns the approved numeric performance-summary operation and fixed
template/schema. `storage.js` owns SQLite and atomic artifacts; `service.js` owns
queue transitions; `http.js` owns authentication and allowlisted serialization;
`runtime.js` wires deployment configuration. `secure_directory.ps1` protects the
Windows store without transmitting account or device identifiers.

Peer trust/status and scoped artifact exchange are implemented separately in
../peers and ../exchange. Explicit peer delegation is in ../delegation, sharing
this bounded queue at its executor. The separate ephemeral text-chat operation
uses the same local engine and admission capacity, with optional text streaming.
There is no arbitrary model selection, tool invocation or automatic action API.

## Text chat

`POST /inference/chat` uses the machine authorization described below. The admin
service provides the browser-facing administrator bridge; browsers cannot call
this endpoint with session cookies or Origin headers. Request version 1 accepts
only `contract_version: 1` and `messages`, with 1–16 `{role, content}` text
messages, user/assistant roles only, a final user message and at most 8192 UTF-8
bytes of serialized history. Its JSON body limit is 16 KiB; all other inference
routes retain their 4096-byte body limit. Query parameters, unknown fields,
system prompts and binary/file parts are rejected. The admin UI can extract
bounded TXT, Markdown, JSON and CSV attachments locally and include the extracted
text and names in ordinary user-message content. That content shares the same
8192-byte history budget; the AI service never receives raw file objects or
stores uploaded files.

Responses contain only `{contract_version: 1, message: {role: "assistant",
content: "..."}}`. Generation uses the configured local model, 512 output tokens,
temperature 0.2, the adapter's 4096-token context and two CPU threads, and a
175-second deadline. Byte admission does not guarantee tokenizer/context fit.
Output text is limited to 64 KiB. Provider thinking, model identifiers and other
metadata are not exposed. With `Accept: application/x-ndjson`, the response emits
version 1 `{type: "delta", text: "..."}` records as generation proceeds, followed
by `{type: "done"}` only after successful engine completion. A failure after
streaming begins emits `{type: "error", error: "CHAT_UNAVAILABLE"}` (or
`CHAT_TIMEOUT`); previously delivered text is partial, not a completed response.
All records include `contract_version: 1`. The default response remains the
ordinary JSON object above. Missing completion, invalid UTF-8/JSON, excess
records and oversized responses are rejected. Streaming uses the same admission,
history, output, token and deadline limits. Both HTTP hops await downstream
backpressure, and nginx buffering is disabled through `X-Accel-Buffering: no`.

Chat shares the service's single generation slot with ordinary inference. New
chats return 429 while another chat or job runs or durable jobs are queued.
Queue dispatch waits during chat. Existing memory/disk admission checks also
apply. Browser disconnect/Stop propagates through the admin bridge to the engine;
shutdown and broken storage also abort chat. Cancellation does not prove instant
engine resource release. Late outputs after cancellation are discarded.

Chat history and output are transient: no job, artifact, knowledge document,
peer exchange or durable transcript is created. The browser sends bounded recent
history each turn and clears it on leaving the page. Chat does not retrieve local
knowledge or execute operational actions. `chat.test.js` tests this contract with
injected adapters; the root `test/admin_chat.test.js` also covers both HTTP hops.

## API version 1

Every `/inference` request requires `X-Fracto-AI-Token`, a generated 32-byte machine
secret encoded as 64 lowercase hex characters. Startup creates `machine-token`
inside the protected store automatically without printing it. A local machine
caller reads that file; tokens are never returned by HTTP. Optional environment
`FRACTO_AI_INFERENCE_TOKEN` overrides the file. Rotate by stopping the service,
replacing the token file/environment secret, then restarting machine callers.
Browser Origin/Cookie headers are rejected. Browser sessions and
`FRACTO_AUTH_REQUIRED=false` grant no access. This credential grants only local
request/inspection APIs, including explicit delegation initiation. It is not a
peer credential and grants no shell access or trust-administration permission.

| Request                                   | Behavior                                                                               |
| ----------------------------------------- | -------------------------------------------------------------------------------------- |
| `POST /inference/jobs`                    | Durable acceptance, HTTP 202; retained identical key replays HTTP 200                  |
| `GET /inference/jobs/:request_id`         | Allowlisted lifecycle and numeric timestamps                                           |
| `GET /inference/jobs/:request_id/result`  | Validated result/provenance; HTTP 409 until completed                                  |
| `POST /inference/jobs/:request_id/cancel` | Persist cancellation before abort; empty body or `{}`                                  |
| `GET /inference/status`                   | Queue counts and limits; no paths/credentials                                          |
| `GET /inference/artifacts/*`              | Authenticated catalog/status/metadata inspection; imported data never enters the queue |

Submission example (generate a fresh random UUIDv4 idempotency key locally):

```json
{
  "contract_version": 1,
  "idempotency_key": "f0cf8768-ff79-48d5-8971-ea01f115e800",
  "operation": "assess_performance",
  "input": {
    "cpu_percent": 20,
    "available_memory_mib": 8000,
    "queue_depth": 0,
    "failure_percent": 0,
    "p95_latency_ms": 100
  },
  "deadline_ms": 180000,
  "max_output_tokens": 256
}
```

All five input fields are required, finite and nonnegative. Percentages are at
most 100, memory at most 1048576 MiB, queue depth at most 1000000 and latency at
most 3600000 ms. Extra fields at either level are rejected. For performance jobs, supply only
non-identifying aggregates: no logs, names, paths, network locations, user/device
IDs, client schemas, messages or free-form text. Request/idempotency IDs identify
random operations, never accounts or devices.

Output contains only enumerated `severity`, `reason` and `recommendation`, checked
independently against the owned schema. This advisory assessment neither measures
performance nor executes changes. Raw provider text/thinking/model names are
discarded. Provenance includes engine, numeric engine version, model digest,
template/schema/profile versions, generation settings, usage and timings; unknown
counters are null. Local job records also retain normalized input, input hash,
configured engine/model, attempt count, states and timestamps.

## Bounds and recovery

- One active generation and 16 pending jobs. Saturation returns 429 `QUEUE_FULL`.
  Authenticated traffic uses one installation-wide token bucket: burst 30,
  refill two requests/sec, without IP/user tracking. Non-chat bodies are limited to
  4096 bytes; compressed bodies and query parameters are rejected. Artifacts
  are at most 8192 bytes. No request-controlled URLs/models or arbitrary options.
- Queue plus execution deadline: 100–180000 ms, default 180000. Output 32–512
  tokens, default 256; context 4096 tokens; temperature zero; Ollama receives
  `num_thread:2` and generation `keep_alive:0`. These are request budgets, not
  OS CPU/RAM quotas or a measured responsiveness guarantee.
- Default headroom floors: 6144 MiB available OS RAM and 1024 MiB free store
  disk. `FRACTO_AI_MIN_FREE_MEMORY_MIB` / `FRACTO_AI_MIN_FREE_DISK_MIB` permit
  positive local overrides. Checks run on admission and dispatch; disk is also
  checked before output publication. Pressure rejects new work with 503 and
  pauses queued work until its original deadline. No memory is reserved and
  active generation is not forcibly evicted for pressure. Inside Docker RAM
  describes the Linux VM/container-visible OS, not Windows host RAM or GPU
  VRAM. Validate both budgets with real-model measurements before enabling work.
- Missing model/engine rejects admission with 503 `MODEL_MISSING` or
  `ENGINE_UNAVAILABLE`; no model is pulled or loaded. Later engine failures are
  durable failed/expired records. No automatic retries, fallback or peer calls.
- Queued cancellation is immediate; running cancellation persists `cancelling`
  before transport abort, then becomes `cancelled`. Late success cannot publish
  a cancelled result. This is request cancellation, not proof of instant engine
  resource release. Terminal cancellation is idempotent.
- Shutdown stops admission and aborts active work; queued work survives. On
  restart, running work becomes `interrupted`, persisted cancelling work becomes
  `cancelled`, and overdue queued work expires. A changed engine/model fails
  queued work as `CONFIGURATION_CHANGED`. Retry requires a fresh key and a
  separate record; exactly-once generation is not claimed.
- Idempotency covers normalized input/settings/template/profile and configured
  engine/model. Different content under a retained key returns 409. Matching
  replay works with the engine offline. There is no cross-request result cache.
  Actual model digest is captured on success, not inferred from configuration;
  interrupted attempts may have unknown actual engine/model provenance.
- Delegated admission additionally persists authenticated origin/key, request hash,
  original deadline and expected engine/digest/profile inside the same job. Internal
  digest pinning rejects changed selections before generation and result publication.
  It grants no forwarding authority. See ../delegation/README.md for scoped RPCs,
  origin receipts, clock/deadline handling and ambiguity rules.
- Storage errors disable inference and abort active transport, with no ephemeral
  fallback. Public `/`, `/healthz`, `/readyz` remain 200 using the existing
  foundation contract. Authenticated inference status describes queue availability;
  public `/engine/status` describes engine availability independently.

## Store and deployment

Node >=22.19 uses built-in `node:sqlite` (experimental in Node 22); no native npm
driver/toolchain or MySQL is needed. New stores migrate transactionally to schema
version 1; unknown versions fail closed. One process holds an exclusive database
lock for the store's lifetime. Use local disk, never a network-shared SQLite file
or one directory shared among native/production/development instances. Reserved
`peer_cursors` is unused until the peer protocol exists.

SQLite uses DELETE rollback journaling, `synchronous=FULL`, no lock wait and
8192 maximum pages (normally 32 MiB at 4 KiB/page). WAL is deliberately avoided.
SHA-256 artifacts publish by exclusive temporary write, file fsync and atomic
same-directory rename before database completion. POSIX also fsyncs the artifact
directory. Node cannot fsync a Windows directory; recovery verifies referenced
hashes and disables inference on missing/corrupt artifacts. Power-loss durability
remains subject to filesystem/SQLite guarantees. Crash-created orphans are pruned.

Terminal retention is seven days and the newest 1000 records, checked at startup,
submission and every minute. Pending/running records are never pruned. A completed
request can briefly exceed the terminal cap until the next pass. Remove database
references first, then unreferenced correctly named owned artifacts; preserve
unrelated files. Idempotency lasts only for retained records; pruned keys may be
reused. Bounded records/artifacts and SQLite page count bound normal store growth.

Native default: ignored `runtime/inference/` in this repository. Optional
`FRACTO_AI_DATA_DIR` selects another **dedicated node-owned** local directory.
Windows disables inherited root permissions and grants the local service identity,
SYSTEM and Administrators. The helper changes access rules only and preserves
existing ownership, avoiding an unnecessary ownership-change privilege requirement.
Use a directory owned by the service account or an approved administrator; the
helper does not take ownership or elevate. New files inherit this ACL; no identities leave local
filesystem administration. POSIX directories/files use 0700/0600.

Compose uses `/var/lib/fracto/ai`, separate production `fracto-ai-data` and
development `fracto-dev-ai-data` volumes. Rebuild for the Dockerfile's node-owned
mount points before using new volumes. Native listener defaults to `127.0.0.1`;
Compose sets `FRACTO_AI_LISTEN_HOST=0.0.0.0` inside the container and publishes the
AI port on host loopback. Both nginx examples block inference. Keep machine
credentials local. The separate peer TLS listener never accepts this token or
exposes local inference; see ../peers/README.md for explicit peer enrollment.

Standalone: `npm ci`, then `npm start` with optional approved local model in
`FRACTO_AI_MODEL`. Store/token creation is automatic, without peers/MySQL/full-stack
preflight. Empty model configuration remains a supported metadata-only install.

## Backup and restore

Stop this AI service and wait for its process/database to close. Copy the entire
dedicated store directory (database, artifacts and any journal) to protected local
backup storage, preserving restrictive permissions. Keep `machine-token` secret;
preserve it only for the same installation's recovery, or rotate before restart.
Never clone machine credentials to another node. Back up model files/configuration
separately; no online backup or peer replica is implemented.
With the default Compose layout, the AI store also contains the private `peers/`
directory. Protect that identity during backup and restore it only to the same
logical installation; never clone it to an independently running node.

Restore into a separate dedicated local directory while stopped, select it with
`FRACTO_AI_DATA_DIR`, start exactly one owner, and check authenticated status and
retained results. Startup validates hashes and interrupted states. Unknown schemas
or corruption disable inference: preserve evidence rather than reset the store.
Restoring old history also restores its old idempotency window; reconcile ambiguous
requests rather than assuming that missing work never executed.

`../inference.test.js` exercises Windows ACL creation, real SQLite ownership,
process-exit recovery, persistence, cancellation races, resources, retention,
corruption, authorization and redaction with synthetic output. These checks
establish lifecycle behavior, not model quality or lab throughput.
