# App-reference retrieval in chat

The admin chat page now offers **General chat** and **App reference**. Switching
modes clears the thread and cancels its current request. General chat retains
the model/text-file workflow. App reference answers a standalone question using
the active evaluated app-reference skill and one complete published UI snapshot.
The answer is deterministic cited reference text, not a model-written synthesis
or a live permission/availability check. No reference data is injected into a
model prompt, and there is no silent model fallback.

Normal startup runs [knowledge refresh](../subject_providers/REFRESH.md) and the
existing [skill bootstrap](README.md) separately, so a fresh store can answer from
the prepared app bundle without manual import/publication. Updated build artifacts
refresh every minute unless disabled or operator-owned selections block handoff.
The chat path itself never creates or repairs either store, evaluates or activates
a skill, or reconciles/publishes an artifact. The [manual snapshot workflow](../subject_providers/SNAPSHOTS.md)
remains available for explicit operator control.

## Request and response contract

Both existing authenticated hops accept the optional `mode` field on version 1
chat requests. Missing mode or `"chat"` uses model chat; `"app-reference"` uses
retrieval. Other modes and extra fields fail validation. Browser requests still
use the trusted-origin administrator bridge (or the explicit private-lab policy);
the AI endpoint still requires the server-owned machine token and rejects browser
Origin/Cookie headers. No provider, skill, source path, schema or action override
can be supplied by a chat client.

```json
{
  "contract_version": 1,
  "mode": "app-reference",
  "messages": [{"role":"user","content":"Where is chat navigation?"}]
}
```

App reference uses only the final user message. History and assistant text cannot
seed its context, and follow-ups must restate the subject. The UI sends only that
question and disables attachments in this mode. Whitespace is normalized to
spaces; the question must fit 512 characters, 1024 UTF-8 bytes and 12 meaningful
terms under the skill tokenizer. Existing 16-message/8192-byte wire limits still
apply. File content has no role in retrieval; use General chat for file analysis.

JSON responses retain the existing `{contract_version,message:{role,content}}`
shape. Streaming retains the existing bounded NDJSON delta/done framing, including
terminal-marker verification and downstream backpressure through both hops.
Reference text is emitted as one bounded delta after retrieval. It includes up
to five exact quotes, document/source/revision and character-offset citations,
the pinned bundle digest and selected skill/definition/executor provenance.
Quotes use fences longer than any backtick run in the quote so Markdown/HTML in
reference text remains literal. A valid snapshot with no matching passages says
so explicitly and lists unmatched terms.

## Runtime isolation and failure behavior

`app_reference/chat.js` opens the existing registry and knowledge stores read-only
per request, dispatches through `run_active`, formats the verified report and
closes both stores before writing a response. It does not use general knowledge
search or historical fallback. Missing, disabled, stale-evaluation or corrupt
reference state yields HTTP 503 `CHAT_REFERENCE_UNAVAILABLE`; invalid reference
questions yield HTTP 400 `CHAT_REFERENCE_QUESTION`. The admin bridge and browser
preserve only those fixed codes, never storage paths, parser details or raw errors.

The AI chat service must be initialized for its machine-authenticated transport;
reference dispatch does not require a running/loaded model and bypasses generation
memory/disk admission and model queue capacity. It has its own cap of 16 concurrent
reference streams and a five-second deadline. Stop, disconnect and service shutdown
abort pending writes and release the reference slot. Existing inference/model
admission rules continue to govern General chat and numeric inference jobs.

Question text, answers and attached data are not persisted in knowledge, the skill
registry or inference jobs, sent to peers, or added to root logs. The registry and
knowledge files remain unchanged by successful reference requests.

`npm run test:chat-reference` tests browser streaming through both real HTTP hops
and persistent read-only skill dispatch in disposable stores: exact citations,
no model or database writes, authorization, strict modes/fields, missing and
disabled state, stale receipts, current-question-only matching, literal markup,
cancellation and bounded concurrency. Existing chat/stream tests cover the shared
origin/admin/machine gates and unchanged general-chat behavior.
