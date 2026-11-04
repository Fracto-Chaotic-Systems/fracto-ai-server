# Explicit whole-request delegation

This module owns a durable origin receipt ledger and the scoped receiver contract.
Every request executes entirely on one explicitly selected peer's local engine.
There is no fan-out, automatic resubmission, recursive forwarding, model switching,
or automatic reuse of imported inference artifacts.

`contracts.js` defines bounded requests/receipts; `receiver.js` admits to the local
inference queue; `storage.js` owns outbound durable state; `runtime.js` submits once
and reconciles status; `http.js` exposes local machine-authorized operations.
`peer_http.js` bounds peer bodies and distinguishes definite rejection from unknown
acceptance. `../delegation.test.js` verifies actual scoped mTLS and failure recovery.

## Execution contract

The origin persists the caller's selected peer, random operation IDs, original
deadline, approved numeric performance-summary request and required engine/model
digest/profile. It never picks another peer, engine or model on the caller's behalf.
The receiver owns the complete engine/model, performs local admission and runs
the complete request through its ordinary queue. No model layers, tensors, KV
cache, weights or decoding are split across installations. Peers communicate only
with the AI service's authenticated TLS listener, never another machine's Ollama.

Only the existing `assess_performance` operation is supported: fixed template,
schema/profile version 1, numeric aggregates, enumerated advisory output, context
4096, CPU thread request 2, temperature 0 and output 32–512 tokens. No request
schemas/prompts, model names, engine URLs, free-form text, credentials, logs or
personal user/device data are accepted or forwarded. Origin/idempotency IDs are
random machine-operation UUIDs, never account or device identifiers.

Every wire submission carries authenticated origin node ID, origin request/key,
one-hop count, creation time, fixed original deadline, remaining budget, expected
engine/digest/profile and the complete approved input. The receiver rejects a
different claimed origin, forwarding fields or any hop count other than one.
Accepted work calls only its own adapter; receiving a delegated job cannot invoke
the outbound coordinator. An authorized caller can deliberately create a separate
new request, but this protocol never forwards the original request recursively.

The required digest must match the configured local selection at admission.
Dispatch passes an internal `expected_model_digest` guard to the common adapter:
Ollama rechecks inventory before transmitting generation messages. Result provenance
must also match the requested engine/digest/profile/output budget before publication
and again at the origin. No silent model fallback or automatic model installation
occurs. These checks use engine-reported metadata; they are not independent
cryptographic attestation of the engine or running weights.

## Explicit authorization and local API

Upgrade both installations before granting delegation: older status clients required
`delegation:false`. No new port, package, model download or external database is
required. Use the existing protected peer directory/AI volume; older source-mounted
containers without that directory remain peer-unavailable until normal recreation.

Grant `inference:delegate` in the origin's **outbound** entry for its chosen peer
and the executor's **inbound** entry for the origin. The reverse direction is a
separate decision. Existing status/artifact grants do not authorize delegation.
Use the existing fingerprint-verified enrollment command or protected trust file.
The CLI replaces directional scope lists: preserve any desired existing status/
artifact scopes when changing them. Grants reload automatically within five seconds.
No job is delegated merely because a peer is enrolled or a grant is present.

Local callers use the existing `X-Fracto-AI-Token`. Browser Origin/Cookie credentials,
lab authentication bypass and peer certificates cannot replace that local token.
All local routes remain behind `/inference` and its nginx block:

| Route                                                    | Behavior                                                                                      |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `GET /inference/delegations/peers/:peer_id/capabilities` | Read that explicitly selected peer's current configured engine/digest/profile; no generation  |
| `POST /inference/delegations`                            | Persist explicit intent; HTTP 202, or 200 for retained identical idempotency key              |
| `GET /inference/delegations/:id`                         | Origin receipt, selected/executing logical peer, state and deadline                           |
| `GET /inference/delegations/:id/result`                  | Validated result and execution provenance, labeled `untrusted_evidence`; 409 until successful |
| `POST /inference/delegations/:id/cancel`                 | Persist cancellation intent; empty body or `{}`                                               |
| `GET /inference/delegations/status`                      | Aggregate pending, completed and unknown outcomes                                             |

Submission example; generate a fresh idempotency UUID, use an approved peer UUID
and replace the example digest with its capability response:

```json
{
  "contract_version": 1,
  "idempotency_key": "d194ed9d-5461-4dc2-819b-18c0eb87ad1c",
  "peer_id": "c1059867-25c7-40cd-bae0-bc70a10020d7",
  "expected": {
    "engine": "ollama",
    "model_digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "profile_version": 1
  },
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

This origin POST acknowledges durable **intent**, not remote acceptance. Poll the
receipt to distinguish prepared, accepted, completed, rejected and unknown states.
The same retained key with different input, peer, deadline or expected profile
returns 409. Repeating an identical local request returns its existing receipt
without submitting again. There is no automatic use of shared artifacts as input,
cache hit or generation context; deliberate reuse remains separate future work.

## Scoped peer protocol

All routes require mTLS plus `inference:delegate`; they expose only the caller's
own operation namespace. Local inference tokens are rejected on this listener.

| Peer route                                            | Purpose                                                              |
| ----------------------------------------------------- | -------------------------------------------------------------------- |
| `GET /peer/v1/delegations/capabilities`               | Configured engine enum/digest/profile and metadata-only availability |
| `POST /peer/v1/delegations`                           | One complete bounded submission, JSON at most 4096 bytes             |
| `GET /peer/v1/delegations/:origin_request_id`         | Reconcile the authenticated origin's own accepted request/result     |
| `POST /peer/v1/delegations/:origin_request_id/cancel` | Idempotently cancel that origin's own request, no body               |

No request-controlled URL, redirect, artifact ID, engine name override or recursive
recipient is accepted. Bodies are allowed only for submission, with exact length,
JSON content type, no compression/chunked transfer, closed fields and strict bounds.
GET/cancel remain bodyless. Responses are at most 8192 bytes, strictly validated
and allowlisted; private provider errors and arbitrary response fields are discarded.
Peer status advertises delegation protocol availability, not guaranteed model,
resource, queue or permission availability. Check capabilities and actual admission.

The receiver derives a private queue idempotency key from the authenticated logical
origin and its operation key. Its queue insertion stores origin binding, original
request hash, expected selection and effective deadline **in the same durable job**.
Concurrent duplicate submissions cannot add a second job; conflicting origin IDs,
keys or content return 409. Status/cancellation cannot inspect another origin's
request even when it knows that request UUID. Trust is rechecked after asynchronous
engine inspection before admission, so revocation cannot enqueue new work there.
Already accepted work may continue after trust is withdrawn; revocation is not an
undo operation. Cancel it first when an acknowledged cancellation is required.

## Ambiguity, deadlines and cancellation

Origin state is persisted as `submitting` **before** the single generation POST.
Lost replies, timeouts, malformed receipts and storage errors after possible
acceptance produce `unknown`, never an automatic retry or different executor.
Restarting with `submitting` also becomes unknown, even if no bytes may have left.
Only genuinely unsent `prepared` work can make its first submission after restart.

The origin automatically reconciles by GET against the same logical peer/request.
A valid receipt confirms execution ownership and eventually its result or terminal
failure. Even a missing remote record does not prove that no inference happened:
history could have been lost or pruned. Reconciliation continues until five minutes
after the original deadline, then records a final unknown outcome and releases its
active slot. The retained receipt remains unknown; no generation is resubmitted.

A definitive `acceptance:rejected` response, or pre-admission scope/rate rejection,
ends that operation as rejected. Storage uncertainty is explicitly `unknown`.
Retrying rejected work requires an explicit new operation/key. Doing so after an
unknown outcome can duplicate computation: reconcile first rather than assuming
that an HTTP failure means rejection. Exactly-once execution is not claimed across
history loss, restoration, retention or explicit creation of a new operation.

The original 100–180000 ms budget includes origin waiting, transit, receiver queue
and generation. The receiver takes the conservative minimum of remaining budget
and absolute deadline, and rejects expired work. Its clock/transit consistency
check permits five seconds; keep clocks synchronized. Receipt completion must be
before its effective deadline. Deadlines and cancellation are request-scoped;
they do not prove instantaneous physical resource release by an independent engine.

Unsent cancellation is immediate and makes no network call. After possible
acceptance, cancellation is durably requested and sent only to the selected
executor, then reconciled. Cancellation messages can be retried idempotently;
generation submissions cannot. The receiver's queue persists cancellation before
aborting transport, and a late response cannot publish a cancelled result. A result
already completed before cancellation remains completed. Unknown cancellation
outcomes are reported honestly. Receiver restarts mark interrupted generation
explicitly; neither node automatically restarts that generation elsewhere.

## Bounds, persistence and deployment

There are at most 16 unresolved outgoing operations, independent of the receiver's
one active generation/16 pending **shared** local queue. Delegated jobs do not bypass
its RAM/disk floors, validation or cancellation. Docker resource checks retain their
existing VM-visible RAM limitation; measure native host/VRAM headroom before enabling
real-model runs. Capability reads do not reserve capacity or load a model.

One delegation network worker runs at a time, polled every 500 ms, with at least one
second between work items for the same peer and five-second status checks. It is
separate from the one status/artifact background worker: at most two such peer tasks
can overlap, plus bounded loopback engine metadata. Existing mTLS connection, body,
rate and five-second request limits still apply. Rate/busy failures have bounded
outcomes; no admission result causes automatic fan-out. Capability reads share the
delegation slot and report busy while it is occupied. No callbacks install models.

`<peer-data-directory>/delegation/delegation.sqlite` holds the origin receipt ledger,
separate from exchange and inference SQLite/MySQL. It uses schema version 1,
exclusive local ownership, DELETE journaling, FULL synchronization and 8192 maximum
pages (normally 32 MiB), protected by the existing Windows ACL/POSIX rules. It
retains at most 1000 terminal receipts/seven days; active reconciliation is bounded
to the request deadline plus five minutes. Idempotency is only for retained history.
Receiver bindings/results are retained with its own jobs under local retention.

No new volume or port is required; normal Fracto startup initializes the ledger
inside the protected peer volume. Store failures stop outgoing work rather than
falling back to memory. Normal process readiness and local inference stay independent
of peer outages. The origin needs no selected local model to delegate, but local
HTTP authorization still requires its local machine credential. Public `/peers/status`
adds only bounded aggregate delegation counts/state, never operation IDs or results.

Stop the AI process before copying its whole protected data, including node identity,
delegation, exchange **and** the receiving inference job store. Restore only to the
same stopped logical installation and reconcile peer history before dispatch.
Older backups can restore pre-submission state or lose acceptance receipts; do not
infer non-execution from them. Never run clones of an identity/store or reset a
damaged schema automatically. Preserve failed data for investigation.

Validation uses synthetic aggregates and fake model output over real mTLS. Tests
cover one-host execution, no origin generation, scope separation, queue saturation,
digest changes, deadlines, cancellation, replay/conflict, scoped status, lost replies,
origin/receiver restart, post-commit acknowledgement failure and malformed provenance.
Actual 48/64 GB lab deployment/enrollment, model provisioning and performance
measurements remain pending; step 8 proves that hardware milestone.
