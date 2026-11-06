import path from "node:path";
import {
  validate_provider,
  validate_documents,
  provider_digest,
  knowledge_source_id,
} from "./contracts.js";
import { canonical, valid_text } from "./validation.js";
import {
  read_source_file,
  source_provenance,
  digest,
  bundle_fail,
  KnowledgeBundleError,
} from "./bundle_sources.js";
import {
  BUNDLE_VERSION,
  GENERATOR_VERSION,
  validate_bundle,
} from "./bundle_contract.js";

const main_root = path.resolve(import.meta.dirname, "../../..");
export const repository_roots = Object.freeze({
  main: main_root,
  ...Object.fromEntries(
    [
      ["ui", "ui"],
      ["ai", "ai-server"],
      ["admin", "admin-server"],
      ["data", "data-server"],
      ["assets", "asset-server"],
      ["tiles", "tiles-server"],
    ].map(([id, suffix]) => [
      id,
      path.join(main_root, "servers", `fracto-${suffix}`),
    ]),
  ),
});

const extractor_code = [
  ["ui", "src/features/knowledge_documents.js"],
  ["ui", "src/features/catalog_contract.js"],
];
const generator_code = [
  "bundle.js",
  "bundle_sources.js",
  "bundle_contract.js",
  "bundle_output.js",
  "contracts.js",
  "validation.js",
].map((file) => ["ai", `subject_providers/${file}`]);
generator_code.push(["main", "scripts/build_knowledge_bundle.js"]);
generator_code.push(
  ...[
    "check_feature_catalog.js",
    "catalog_navigation.js",
    "catalog_source_facts.js",
  ].map((file) => ["ui", `scripts/${file}`]),
);
const fingerprint = (files) =>
  digest(
    canonical(
      files.map(([repository, file]) => ({
        repository,
        path: file,
        digest: digest(
          read_source_file(repository_roots[repository], file, 1048576),
        ),
      })),
    ),
  );

/** Built-in extractor IDs select reviewed code, never a definition-supplied path. */
const extract = async (provider, sources, signal) => {
  if (
    provider.extractor.id !== "ui-catalog" ||
    provider.extractor.version !== "1.0.0"
  )
    bundle_fail("UNSUPPORTED_BUNDLE_EXTRACTOR");
  const { extract_ui_catalog } =
    await import("../../fracto-ui/src/features/knowledge_documents.js");
  return extract_ui_catalog({ sources, signal });
};

export const generate_bundle = async ({
  definition,
  roots = repository_roots,
  signal,
  provenance = source_provenance,
  check_sources,
} = {}) => {
  const provider = validate_provider(definition);
  if (
    provider.extractor.id !== "ui-catalog" ||
    provider.extractor.version !== "1.0.0"
  )
    bundle_fail("UNSUPPORTED_BUNDLE_EXTRACTOR");
  const snapshots = [],
    sources = [];
  let total = 0;
  for (const source of provider.sources) {
    signal?.throwIfAborted();
    const root = roots[source.repository];
    if (typeof root !== "string") bundle_fail("BUNDLE_SOURCE_UNAVAILABLE");
    const input = read_source_file(
      root,
      source.path,
      provider.limits.source_bytes,
    );
    total += input.length;
    if (total > provider.limits.total_source_bytes)
      bundle_fail("BUNDLE_SOURCE_TOO_LARGE");
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(input);
    } catch {
      bundle_fail("INVALID_BUNDLE_SOURCE");
    }
    if (!valid_text(text)) bundle_fail("INVALID_BUNDLE_SOURCE");
    snapshots.push({ id: source.id, text });
    sources.push({
      ...source,
      digest: digest(input),
      bytes: input.length,
      ...provenance(root, source.path, digest(input)),
    });
  }
  try {
    await check_sources?.(snapshots);
    const documents = validate_documents(
      provider,
      await extract(provider, snapshots, signal),
    );
    signal?.throwIfAborted();
    const manifest = {
      provider,
      provider_digest: provider_digest(provider),
      generator: {
        id: "subject-bundle",
        version: GENERATOR_VERSION,
        fingerprint: fingerprint(generator_code),
      },
      extractor: {
        ...provider.extractor,
        fingerprint: fingerprint(extractor_code),
      },
      sources,
      documents: documents.map((document) => ({
        id: document.id,
        source: knowledge_source_id(provider, document.id),
        revision: `v${digest(document.text)}`,
        digest: digest(document.text),
        bytes: Buffer.byteLength(document.text),
        format: provider.documents.find((entry) => entry.id === document.id)
          .format,
        source_ids: document.source_ids,
      })),
    };
    const body = {
      contract_version: BUNDLE_VERSION,
      manifest,
      documents: documents.map(({ id, text }) => ({ id, text })),
    };
    return validate_bundle({ ...body, digest: digest(canonical(body)) });
  } catch (error) {
    if (signal?.aborted || error instanceof KnowledgeBundleError) throw error;
    bundle_fail("BUNDLE_EXTRACTION_FAILED");
  }
};
