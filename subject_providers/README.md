# Application subject-provider contract

This is the first foundation for app-information seeding. `contracts.js` validates
version 1 provider declarations and extractor document results. `validation.js`
owns internal shape, label, path, text and heading checks. Neither module reads
files, executes providers, writes stores, seeds startup, activates skills, exposes
HTTP routes or publishes to peers. `ui.json` now declares the reviewed structured
UI catalog and seven area documents. A reviewed build-time extractor now emits
a deterministic bundle. Explicit local reconciliation now persists the reviewed
UI artifact; no provider is registered for automatic startup.
See [bundle generation](BUNDLES.md) for artifact and provenance contracts.
See [persistent reconciliation](RECONCILIATION.md) for atomic adoption and overrides.
See [complete snapshots](SNAPSHOTS.md) for separate local publication and pinned reads.

Knowledge documents describe application facts. Skill releases separately version
the reviewed behavior used to retrieve those facts. Updating documents must not
implicitly publish/activate skills or undo operator retirement and local edits.

## Provider declaration

```json
{
  "contract_version": 1,
  "provider_id": "ui-features",
  "subject_id": "application-ui",
  "extractor": { "id": "ui-catalog", "version": "1.0.0" },
  "sources": [
    { "id": "catalog", "repository": "ui", "path": "src/features/catalog.json" }
  ],
  "documents": [
    {
      "id": "navigation",
      "source_ids": ["catalog"],
      "format": "markdown",
      "validation": {
        "profile": "reference-text-v1",
        "required_sections": ["Purpose", "Permissions"]
      }
    }
  ],
  "limits": {
    "source_bytes": 262144,
    "total_source_bytes": 1048576,
    "document_bytes": 65536,
    "total_document_bytes": 262144
  }
}
```

The example illustrates the contract; the complete current declaration is
`ui.json`, referencing `ui/src/features/catalog.json`. Neither registers an extractor.
Provider, source and document IDs are stable lowercase kebab-case, at most 32
characters; subject IDs allow 40. Extractor versions are numeric MAJOR.MINOR.PATCH
with each component 0–999 and no leading zeroes. Contract versions describe schema
compatibility, independently of source content, extractor and skill versions.

Repository IDs are `main`, `ui`, `admin`, `ai`, `data`, `assets`, and `tiles`.
They are logical names: a future runner supplies reviewed checkout roots. Paths
are exact, portable repository-relative paths, never URLs, absolute paths,
globs, traversal or commands. Extensions are MD, TXT, JSON, JS/JSX, TS/TSX and
YAML/YML (lowercase extensions). Dotfiles, deployment `config`, runtime, logs,
dependencies, built output and secret/credential directories are excluded.
Case-insensitive duplicate locations and Windows device names are rejected.

Declarations are reviewed application data, not user-provided read permissions.
Path validation cannot establish that a file is public or non-personal. The future
reader must enforce approved roots/real-path containment, reject symlinks and
reparse-point escapes, enforce actual source byte limits, and review/sanitize
source content. It must never execute imported JSX/JS or accept an extractor
module path from a definition. Extractor IDs resolve only through a reviewed code
allowlist; this step intentionally supplies no resolver or executable provider.

## Extractor boundary and results

The future runner owns source reading and provenance. A reviewed extractor will
implement `extract({sources, signal})`, returning a promise of document records.
Each supplied source contains its declared `id` and `text`; no checkout roots,
filesystem handles, stores or credentials are passed to the extractor. It returns
an array of `{id, text, source_ids}` documents. Output must be deterministic for
the same declaration/version and source bytes. It must not read additional files,
fetch URLs, invoke models, execute actions or access stores. Reviewed code and
runner isolation enforce that boundary; declaration validation alone does not.

`validate_documents(provider, documents)` requires every declared document exactly
once, no undeclared documents, and each document's exact declared source-reference
set. Missing/partial output fails extraction, never implies retirement/deletion.
`reference-text-v1` requires nonempty UTF-8-representable text without binary
control characters. Markdown may require exact ATX heading titles outside fenced
code blocks; plain text cannot declare required sections. These structural checks
do not establish factual truth, completeness or absence of personal information.

Limits are positive integers. Hard ceilings: 32 KiB canonical declaration, 64
sources, 64 documents, 1 MiB per source/8 MiB combined source input, and 64 KiB per
document/1 MiB combined output. Providers may lower limits. This module validates
source-limit declarations and enforces output limits on supplied text. The bundle
reader now enforces actual source limits. All byte limits use UTF-8.

`validate_provider` returns detached data with sorted declarations/source refs.
`provider_digest` hashes that normalized declaration; property, source, document
and source-reference ordering do not affect the hash. Required heading order
remains significant. This digest identifies a declaration, not source content,
Git state, approval or a generated bundle; the bundle pipeline records those
separately and does not infer approval from hashes.

`knowledge_source_id(provider, document_id)` reserves
`app-<provider-ID-length>-<provider_id>-<document_id>` (at most 72 characters),
within the existing 80-character knowledge label limit. The length prefix makes
provider/document boundaries unambiguous. A future registry must enforce unique
provider IDs. Renaming stable IDs requires a migration, not a content update.

Fixed `SubjectProviderError` codes are `INVALID_SUBJECT_PROVIDER` for declarations
and `INVALID_PROVIDER_DOCUMENTS` for extractor results. Errors include no source
text, local paths, credentials or parser details.

## Next integration steps

The structured UI catalog now lives in the UI checkout, with registration drift
checks and a build-time declaration here. The reviewed extractor/source reader now
generate a provenance-bearing bundle. Explicit reconciliation now adds persistent
staging and provider ownership while respecting retirement/local overrides.
Separate complete snapshot publication now supplies atomic generation selection
and pinned reads. The [app-reference skill](../app_reference/README.md) now bootstraps
through the existing registry and retrieves exact passages from one publication.
The explicit [App reference chat mode](../app_reference/CHAT.md) now dispatches
that retrieval through the authorized chat transport. Automatic live bundle
seeding now runs through the [automatic refresh lifecycle](REFRESH.md), with
transactional publication, persistent operator control and cross-repository CI
regression checks.

Run `node --test subject_providers.test.js` from the AI checkout. The normal
service syntax check includes this directory; tests need no model or store.
