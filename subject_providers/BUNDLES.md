# Deterministic knowledge bundles

The build tool converts the reviewed UI catalog into seven Markdown documents,
one per area. This is build preparation only: it never opens the knowledge store,
skill registry or inference runtime, changes active selections, calls a model,
publishes to peers, or sends source contents over HTTP.

From the Fracto root:

```powershell
npm run knowledge:bundle
npm run knowledge:bundle:check
npm run test:knowledge-bundle
```

`knowledge:bundle` runs the catalog's source drift checks, validates the provider
declaration, reads only its explicitly declared input, invokes the reviewed
extractor, validates every output and atomically writes
`servers/fracto-ai-server/generated/knowledge/ui-features.bundle.json`.
`--check` recomputes the expected bytes and fails on missing/stale output without
creating directories or modifying the artifact. An identical build leaves the
existing artifact and its modification time unchanged.

UI npm builds generate the bundle after the catalog check. Production Docker
builds retain the artifact in the final image. Development image preparation also
generates one with node ownership. Host-generated artifacts are excluded from
Docker context so images generate their own provenance. A development bind mount
can hide the image's generated directory: run the root bundle command against the
mounted source checkout when needed. Vite development now rebuilds automatically;
the separate [refresh lifecycle](REFRESH.md) consumes prepared bundles at AI
startup and every minute without running extraction in the AI process.

## Artifact contract

Version 1 is one self-contained JSON object containing `contract_version`,
`manifest`, `documents` and `digest`. Serialization sorts object keys, uses UTF-8
and LF, and includes a final newline. Source/document arrays use stable ID order.
There are no timestamps, hostnames, absolute paths, author identities, remotes,
configuration values or random identifiers inside the artifact. Temporary output
filenames are random but do not enter its bytes or digest.

The manifest contains:

- The normalized provider declaration and its SHA-256 digest.
- Generator ID/version and a fingerprint of its reviewed source files.
- Extractor ID/version and a fingerprint of the renderer and catalog validator.
- Each declared source's logical repository/path, exact byte size and SHA-256,
  available repository HEAD, and `committed`, `modified`, `unversioned` or
  `unknown` source state.
- Each document's ID, format, logical knowledge-source label, byte size, SHA-256,
  source references and content-derived revision (`v` plus its SHA-256).

The top-level digest hashes the canonical object without its own digest field.
It binds the complete manifest and document text together. `validate_bundle`
checks exact fields, declaration/document coverage, limits, text hashes,
revisions, source labels and the bundle digest. A valid hash establishes
integrity, not factual truth, approval or permission to adopt an artifact.

Git revision changes can change the bundle manifest even if document text stays
the same; document revisions still remain unchanged. Source content changes
revise only the documents whose generated text changes. When Git metadata is
absent (including clean image archives), provenance records null revision and
`unknown` state rather than inventing a commit. Byte digests remain authoritative
for the exact input snapshot. Working-tree provenance is not an atomic Git-tree
snapshot or an independently verified attestation.

The UI provider currently consumes **only the catalog JSON**. Source references
within that catalog identify ownership; their contents are not ingested or
separately hashed as provider input. The build command's separate drift check
validates live registration metadata first. Descriptive truth, permission
semantics and completeness still require source-owner review.

## Modules and bounds

- `bundle_sources.js`: approved-root containment, link/device rejection, bounded
  regular-file byte reads and minimal Git provenance.
- `bundle.js`: fixed `ui-catalog/1.0.0` extractor selection, strict UTF-8 source admission,
  implementation fingerprints and complete bundle assembly. Definitions cannot
  select a module, executable or URL. The reviewed UI renderer lives in
  `ui/src/features/knowledge_documents.js`; it receives text and cancellation only.
- `bundle_contract.js`: artifact schema/integrity validation and canonical bytes.
- `bundle_output.js`: fixed generated destination, idempotence, check-only mode,
  temporary-file fsync and whole-artifact rename.
- Root `scripts/build_knowledge_bundle.js`: CLI/build orchestration and source
  drift checks. It requires the full Fracto source checkout and UI development
  dependencies; it is not a runtime or peer API.

Input limits come from the provider contract (1 MiB per UI catalog input). Output
is at most 64 KiB per area document and 1 MiB combined. The serialized bundle is
limited to 4 MiB including escaped text and metadata. Invalid UTF-8, binary
controls, missing documents, unapproved extractor versions, oversize input/output
and source changes during a read fail the build with fixed codes. No partial set
of documents is published. Unknown or unavailable sources never mean deletion.

Source paths reject links/reparse-point escapes and non-regular files; directory
roots are chosen by the reviewed build tool. Keep checkout/output directories
under operator control; this is not an adversarial filesystem sandbox for
third-party extractor code. Registry definitions remain inert.

The writer preserves the previous artifact on generation/validation or rename
failure and removes its own temporary file. POSIX publication also fsyncs the
directory; Windows cannot provide that directory-fsync guarantee. Power-loss
durability still depends on the filesystem. The explicit
[persistence reconciler](RECONCILIATION.md) validates the entire bundle before
importing and selecting it transactionally.

Tests use disposable roots and synthetic Git metadata, plus the checked-in UI
catalog. They cover deterministic bytes across relocated roots, content/provenance
changes, altered manifests, UTF-8 and size failures, source links/escapes,
concurrent input changes, idempotence and interrupted publication. Full UI
integration tests require the sibling UI checkout; source/Git-reader tests remain
independent of it. No model, store or live deployment is used.
