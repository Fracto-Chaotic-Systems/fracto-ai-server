import { createHash } from "node:crypto";
import {
  fail,
  object,
  label,
  version,
  list,
  unique,
  bytes,
  integer,
  safe_path,
  canonical,
  valid_text,
  headings,
} from "./validation.js";
export { SubjectProviderError } from "./validation.js";

export const CONTRACT_VERSION = 1;
export const REPOSITORIES = Object.freeze([
  "main",
  "ui",
  "admin",
  "ai",
  "data",
  "assets",
  "tiles",
]);
export const LIMITS = Object.freeze({
  definition_bytes: 32768,
  sources: 64,
  documents: 64,
  source_bytes: 1048576,
  total_source_bytes: 8388608,
  document_bytes: 65536,
  total_document_bytes: 1048576,
});

/** Pure declaration validation. It neither reads sources nor resolves an extractor. */
export const validate_provider = (definition) => {
  object(definition, [
    "contract_version",
    "provider_id",
    "subject_id",
    "extractor",
    "sources",
    "documents",
    "limits",
  ]);
  if (definition.contract_version !== CONTRACT_VERSION) fail();
  label(definition.provider_id);
  label(definition.subject_id, 40);
  object(definition.extractor, ["id", "version"]);
  label(definition.extractor.id);
  version(definition.extractor.version);
  object(definition.limits, [
    "source_bytes",
    "total_source_bytes",
    "document_bytes",
    "total_document_bytes",
  ]);
  for (const [key, value] of Object.entries(definition.limits))
    integer(value, LIMITS[key]);
  if (
    definition.limits.source_bytes > definition.limits.total_source_bytes ||
    definition.limits.document_bytes > definition.limits.total_document_bytes
  )
    fail();
  list(definition.sources, LIMITS.sources);
  list(definition.documents, LIMITS.documents);
  for (const source of definition.sources) {
    object(source, ["id", "repository", "path"]);
    label(source.id);
    if (!REPOSITORIES.includes(source.repository)) fail();
    safe_path(source.path);
  }
  unique(definition.sources.map((source) => source.id));
  unique(
    definition.sources.map(
      (source) => `${source.repository}:${source.path.toLowerCase()}`,
    ),
  );
  const source_ids = new Set(definition.sources.map((source) => source.id));
  for (const document of definition.documents) {
    object(document, ["id", "source_ids", "format", "validation"]);
    label(document.id);
    if (!["markdown", "text"].includes(document.format)) fail();
    list(document.source_ids, LIMITS.sources);
    unique(document.source_ids);
    if (!document.source_ids.every((id) => source_ids.has(id))) fail();
    object(document.validation, ["profile", "required_sections"]);
    if (document.validation.profile !== "reference-text-v1") fail();
    list(document.validation.required_sections, 16, 0);
    unique(document.validation.required_sections);
    if (
      document.format === "text" &&
      document.validation.required_sections.length
    )
      fail();
    for (const section of document.validation.required_sections) {
      if (
        typeof section !== "string" ||
        section.length > 120 ||
        !valid_text(section) ||
        section !== section.trim() ||
        /[\r\n\t]/.test(section)
      )
        fail();
    }
  }
  unique(definition.documents.map((document) => document.id));
  if (bytes(canonical(definition)) > LIMITS.definition_bytes) fail();
  const copy = JSON.parse(canonical(definition));
  const by_id = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  copy.sources.sort(by_id);
  copy.documents.sort(by_id);
  for (const document of copy.documents) document.source_ids.sort();
  return copy;
};

export const provider_digest = (definition) =>
  createHash("sha256")
    .update(canonical(validate_provider(definition)))
    .digest("hex");

/** Length prefix prevents ambiguous provider/document splits; maximum 72 chars. */
export const knowledge_source_id = (definition, document_id) => {
  const provider = validate_provider(definition);
  if (!provider.documents.some((document) => document.id === document_id))
    fail();
  return `app-${provider.provider_id.length}-${provider.provider_id}-${document_id}`;
};

/** Validate a complete extractor result; absent documents never mean retirement. */
export const validate_documents = (definition, documents) => {
  const provider = validate_provider(definition);
  try {
    list(documents, provider.documents.length, provider.documents.length);
    unique(documents.map((document) => document.id));
    let total = 0;
    const result = [];
    for (const document of documents) {
      object(document, ["id", "text", "source_ids"]);
      const declared = provider.documents.find(
        (entry) => entry.id === document.id,
      );
      if (
        !declared ||
        typeof document.text !== "string" ||
        document.text.length > provider.limits.document_bytes
      )
        fail();
      const size = bytes(document.text);
      total += size;
      if (
        size > provider.limits.document_bytes ||
        total > provider.limits.total_document_bytes
      )
        fail();
      if (!valid_text(document.text)) fail();
      list(
        document.source_ids,
        declared.source_ids.length,
        declared.source_ids.length,
      );
      unique(document.source_ids);
      if (!document.source_ids.every((id) => declared.source_ids.includes(id)))
        fail();
      const titles = headings(document.text);
      if (
        !declared.validation.required_sections.every((section) =>
          titles.has(section),
        )
      )
        fail();
      result.push({
        id: document.id,
        text: document.text,
        source_ids: [...document.source_ids].sort(),
      });
    }
    return result.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  } catch {
    fail("INVALID_PROVIDER_DOCUMENTS");
  }
};
