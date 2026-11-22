import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  generate_bundle,
  repository_roots,
} from "../subject_providers/bundle.js";
import { read_source_file } from "../subject_providers/bundle_sources.js";
import { write_bundle } from "../subject_providers/bundle_output.js";
import {validate_catalog as check_catalog} from "@fracto/sdk/catalog/CatalogContract.js";

/** Build preparation only: no knowledge database or skill registry is opened. */
export const build_knowledge_bundle = async ({ check = false } = {}) => {
  const definition = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(
      read_source_file(repository_roots.ai, "subject_providers/ui.json", 32768),
    ),
  );
  const bundle = await generate_bundle({
    definition,
    check_sources: (sources) => check_catalog(JSON.parse(sources[0].text)),
  });
  const output = write_bundle(repository_roots.ai, bundle, { check });
  return {
    ...output,
    digest: bundle.digest,
    documents: bundle.documents.length,
    source_bytes: bundle.manifest.sources.reduce(
      (total, source) => total + source.bytes,
      0,
    ),
  };
};

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (
      process.argv.slice(2).some((argument) => argument !== "--check") ||
      process.argv.length > 3
    )
      throw new Error("INVALID_BUNDLE_ARGUMENTS");
    const result = await build_knowledge_bundle({
      check: process.argv.includes("--check"),
    });
    console.log(
      `UI knowledge bundle ${result.changed ? "generated" : "unchanged"}: ${result.documents} documents, SHA-256 ${result.digest}`,
    );
  } catch (error) {
    const allowed = [
      "INVALID_BUNDLE_ARGUMENTS",
      "INVALID_SUBJECT_PROVIDER",
      "INVALID_PROVIDER_DOCUMENTS",
      "INVALID_BUNDLE_SOURCE",
      "BUNDLE_SOURCE_UNAVAILABLE",
      "BUNDLE_SOURCE_TOO_LARGE",
      "BUNDLE_SOURCE_CHANGED",
      "UNSUPPORTED_BUNDLE_EXTRACTOR",
      "INVALID_KNOWLEDGE_BUNDLE",
      "BUNDLE_EXTRACTION_FAILED",
      "KNOWLEDGE_BUNDLE_STALE",
      "BUNDLE_OUTPUT_UNAVAILABLE",
    ];
    console.error(
      `Knowledge bundle failed: ${allowed.includes(error.code || error.message) ? error.code || error.message : "BUNDLE_BUILD_FAILED"}`,
    );
    process.exitCode = 1;
  }
}
