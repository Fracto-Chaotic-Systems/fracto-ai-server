# Engine adapters

These modules implement an internal, engine-neutral inference boundary. Only the
Ollama backend is implemented. `llama_cpp`, `vllm` and `sglang` are registered but
unavailable, and never fall back silently to another engine.

- `registry.js`: adapter factory, implementation registry and environment-owned status reader.
- `ollama.js`: metadata/status, selected-local-model checks, generation and explicit warm-up.
- `contracts.js`: request limits, model identifiers and supported JSON Schema subset.
- `transport.js`: loopback-only JSON transport, redirect rejection and bounded response bodies.
- `protocol.js`: allowlisted model inventory and provider-neutral generation results.
- `errors.js`: fixed error codes/messages and whole-operation deadlines.
- `public_status.js`: fixed-field status serialization, excluding private adapter/provider metadata.

## Interface

Construct `create_engine_adapter({engine, base_url, model})`. The configured model
is fixed per adapter; generation requests cannot override it or the engine URL.
Ollama defaults to `http://127.0.0.1:11434`. Only HTTP loopback origins are allowed;
credentials, URL paths/query/fragments, redirects and remote hosts are rejected.
The only additional host is `host.docker.internal`, requiring explicit
`allow_host_gateway:true` (environment `FRACTO_OLLAMA_ALLOW_HOST_GATEWAY=true`).
The production/development Compose profiles opt into that same-machine Docker
Desktop path and default `FRACTO_OLLAMA_URL` to `http://host.docker.internal:11434`.
This transport was verified against the Windows-loopback engine without changing
its listener binding. Other Docker/Linux host-network configurations need their
own validation; failure is reported as unavailable rather than exposing the
engine to the LAN. Native Windows defaults remain loopback-only.

Methods: `health({signal, timeout_ms})`, `list_models({signal, timeout_ms})`,
`status()`, `generate(request)`, `warmup({signal, timeout_ms})`, `embed()` and
`stream()`. Embeddings and streaming currently fail with `UNSUPPORTED_OPERATION`.

Generation requests allow only `messages`, `schema`, `max_tokens`, `temperature`,
`signal`, `timeout_ms`, optional `stream:false` and `expected_model_digest`.
The optional digest guard is exactly 64 lowercase hex characters; a selection
mismatch fails with `MODEL_MISMATCH` before transmitting generation messages.
It never selects a different model. Messages contain only
`role` (`system`, `user`, `assistant`) and string `content`. Limits: 16 messages,
8 KiB serialized messages, 1–1024 output tokens (default 512), temperature 0–2
(default 0), and a 1–180000 ms deadline (default 180000). Context is fixed at 4096
tokens, with `num_thread:2` for generation and warm-up. Thread settings are not OS
CPU quotas. Byte limits are admission guards, not exact tokenizer/context-fit
guarantees. The request service in ../inference uses fixed numeric-only templates
and a narrower output budget, with no general-purpose prompt API.

Callers must supply only validated non-personal operational/world content. Shape
validation cannot establish that arbitrary text contains no personal information.
This library does not authorize user/peer input or expose a raw prompt API.

The adapter checks the configured model against `/api/tags` and `/api/show` before
sending any messages. Missing models are not pulled. Cloud model aliases/remote
model descriptors are rejected. Only local completion-capable models are used.
Reasoning output, tool calls, images, engine URLs and arbitrary options are not
part of the contract. No warm-up or generation happens during health/status reads.

## Structured results and capabilities

JSON Schema support is an explicit bounded draft-07 subset: `type`, `properties`,
`required`, `additionalProperties`, `items`, `enum`, `const`, `minimum`, `maximum`,
`minLength`, `maxLength`, `minItems`, `maxItems`, `title`, `description` and the
canonical draft-07 `$schema`. Schemas are limited to 16 KiB, nesting depth 8 and
512 schema nodes. Other keywords, references, executable patterns, formats and
unknown dialects are rejected. Ajv validates the schema and the parsed generated
JSON independently; no coercion, extra-field removal or default insertion occurs.

Results contain `engine`, `engine_version`, `model`, `model_digest`, `text`,
`structured`, normalized `finish_reason`, token `usage`, and `timings_ms`.
Provider nanoseconds become milliseconds. Missing/invalid counters are null,
not invented measurements. Extra provider fields and thinking/tool payloads
are not returned. Invalid generated JSON/schema results fail with `INVALID_OUTPUT`.

`adapter_features` describes implementation support, not proof of model quality
or current availability. Streaming/embeddings are false. Cancellation aborts the
request/transport; it does not acknowledge that all backend work has stopped.
Generation is single-flight per adapter instance, with immediate `ENGINE_BUSY`
rejection; keep a shared adapter rather than constructing one per request.
Node-wide admission across multiple profiles and durable queues are step 4.
One deadline covers metadata, transport and body consumption. Engine responses
are bounded to 2 MiB and generated text to 64 KiB, with strict UTF-8 decoding.
Errors have fixed codes/messages and never contain engine error bodies, prompts,
response text, URLs, credentials or model identifiers.

Explicit `warmup()` loads the selected model with a 30-second keep-alive and
reports `warming` while in progress. It must be admitted by its caller's resource
policy. Generation reports `busy` (including any cold load), and requests model
unloading afterward. Neither is invoked automatically by startup or status.

## Read-only status

The service exposes `GET /engine/status`, contract version 1. Configure
`FRACTO_AI_ENGINE` (default `ollama`), optional `FRACTO_AI_MODEL`, and optional
`FRACTO_OLLAMA_URL` in the service's deployment environment. Its public response
contains only implementation flags, engine version, model counts/presence,
activity and fixed error codes. Public versions contain only the numeric version,
excluding custom build suffixes. Model identifiers, input/output, endpoint URLs
and complete provider records are not published. Metadata reads are coalesced
and cached for five seconds, with a shared three-second probe deadline.

States: `engine_unavailable`, `model_missing` (including no selected model),
`ready`, `warming`, `busy`, `adapter_unavailable`, or `configuration_error`.
Busy/warming describe this adapter's own operation, not a global view of other
Ollama clients. Engine/model failure never changes the service's foundation
`/healthz` or `/readyz` contract. Inference submission remains a later authenticated,
bounded service feature; this step exposes no generation route.
