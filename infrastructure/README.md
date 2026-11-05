# Read-only infrastructure reference skill

This is the first application skill, not a Codex skill. The local
[skill registry](../skills/README.md) controls its active release and evaluation
gate; the question CLI requires a valid active release and reports its version/digests.
`reference.js` performs bounded lexical retrieval and returns exact source passages
with citations. `cli.js` opens the knowledge database read-only. `seed.js` imports
only the four bundled, reviewed `.md` references during ordinary AI startup;
it never crawls repositories, reads deployment configuration or fetches URLs.
The bundled references describe ownership, terrain flow, AI deployment boundaries
and game authority. They summarize the local project documentation reviewed for
this increment; they are reference baselines, not live infrastructure inspection.

## Use

After the next standard AI service start, from the AI service directory:

```powershell
node --env-file-if-exists=.env infrastructure/cli.js ask "Which service owns terrain mesh storage?"
node --env-file-if-exists=.env infrastructure/cli.js ask "Can the AI server change game state directly?"
```

For Docker development, from the Fracto root:

```powershell
docker compose -f compose.yaml -f compose.dev.yaml exec -T fracto-dev node servers/fracto-ai-server/infrastructure/cli.js ask "Which service owns terrain mesh storage?"
```

`ask` takes one question, at most 512 characters / 1024 UTF-8 bytes. It extracts up
to 12 meaningful terms, supports a small explicit infrastructure alias vocabulary,
and searches each term through the knowledge store's bounded FTS interface. Up to
five findings cite exact source ranges (UTF-16 string offsets), source/revision,
SHA-256 digest and chunk. Each quote is at most 600 characters. More terms or
ambiguous questions should be split into narrower questions.

The answer type is **extractive_reference**: it reports passages and retrieval
coverage, not model-generated synthesis or a claim that the question has been
fully answered. `evidence_found` means relevant words matched, not truth or
confidence. Unmatched terms and `insufficient_evidence` expose retrieval gaps.
Every report states `live_verified:false` and `evidence_only:true`. A source can
be current in the local library yet outdated relative to running services.
This increment adds no LLM call, embedding, inference task, environment validator,
data correction, shell tool, SQL generation or action execution. It therefore
works while Ollama is absent or memory admission rejects inference. Semantic
reasoning and live read-only inspection need separate bounded contracts later.

All local knowledge is eligible evidence, including explicitly curated imports;
retired and superseded revisions are excluded. Quoted instructions are inert
data: the skill has no executor or tools. It neither persists questions/results
nor writes the database, changes ACLs, seeds documents or cleans orphans while
answering. The knowledge read transaction provides one consistent source snapshot.
Corruption or an unavailable store fails closed with a generic fixed error code.
There is no question/text HTTP endpoint, model transmission, peer exchange or
question logging through the root API. Use the service identity for local access.

## Bundled reference lifecycle

Startup's separate seed writer creates `builtin-ownership`, `builtin-terrain`,
`builtin-ai-deployment` and `builtin-game-authority`. Revision labels are `v` plus
the SHA-256 of the bundled text. Unchanged starts are idempotent; changed bundled
text creates a revision using compare-and-swap. Explicitly retired references
stay retired. An active reference changed manually is left under local ownership;
the seed updates only a current revision with a valid bundled digest label.
Retire any stale bundle with the knowledge CLI and curate a replacement source
until the bundled reference is reviewed. The seed owns these reserved labels;
do not use digest-shaped revision labels for manual replacements.

Seed failure is logged as a fixed code and does not disable existing knowledge,
inference or Fracto readiness. No new service, port, dependency, persistent volume
or model download is required. Standard build checks include `../infrastructure.test.js`.

## References reviewed

- `servers/README.md`: root supervision and service ownership.
- `sdk/terrain/README.md` and tiles-service README: terrain caches and mesh assembly.
- AI `ROADMAP.md`, `FIRST_STAGE.md`, `OLLAMA.md`, inference/peer READMEs:
  independent local engines, persistence, resource bounds and future game actions.

Revisit these summaries when their owning contracts change; automatic upstream
staleness detection remains future work; version publication/activation is now
implemented by the local registry. Registry releases version the procedure and
execution contract independently of the knowledge document revisions they retrieve.
