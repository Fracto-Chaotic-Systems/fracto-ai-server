import {
  validate_provider,
  validate_documents,
  provider_digest,
  knowledge_source_id,
} from "./contracts.js";
import { canonical, object } from "./validation.js";
import { bundle_fail, digest } from "./bundle_sources.js";

export const BUNDLE_VERSION = 1;
export const GENERATOR_VERSION = "1.0.0";
export const MAX_BUNDLE_BYTES = 4 * 1024 * 1024;
const hash = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const bundle_bytes = (bundle) =>
  Buffer.from(canonical(bundle) + "\n", "utf8");

/** Integrity/structure checking does not attest source truth or authorize adoption. */
export const validate_bundle = (bundle) => {
  try {
    object(bundle, ["contract_version", "manifest", "documents", "digest"]);
    if (bundle.contract_version !== BUNDLE_VERSION || !hash(bundle.digest))
      throw new Error();
    const { manifest } = bundle;
    object(manifest, [
      "provider",
      "provider_digest",
      "generator",
      "extractor",
      "sources",
      "documents",
    ]);
    const provider = validate_provider(manifest.provider);
    if (
      canonical(provider) !== canonical(manifest.provider) ||
      manifest.provider_digest !== provider_digest(provider)
    )
      throw new Error();
    object(manifest.generator, ["id", "version", "fingerprint"]);
    if (
      manifest.generator.id !== "subject-bundle" ||
      manifest.generator.version !== GENERATOR_VERSION ||
      !hash(manifest.generator.fingerprint)
    )
      throw new Error();
    object(manifest.extractor, ["id", "version", "fingerprint"]);
    if (
      manifest.extractor.id !== provider.extractor.id ||
      manifest.extractor.version !== provider.extractor.version ||
      !hash(manifest.extractor.fingerprint)
    )
      throw new Error();
    if (
      !Array.isArray(manifest.sources) ||
      manifest.sources.length !== provider.sources.length
    )
      throw new Error();
    let source_bytes = 0;
    manifest.sources.forEach((source, index) => {
      object(source, [
        "id",
        "repository",
        "path",
        "digest",
        "bytes",
        "repository_revision",
        "source_state",
      ]);
      const declared = provider.sources[index];
      if (
        source.id !== declared.id ||
        source.repository !== declared.repository ||
        source.path !== declared.path ||
        !hash(source.digest) ||
        !Number.isSafeInteger(source.bytes) ||
        source.bytes < 1 ||
        source.bytes > provider.limits.source_bytes
      )
        throw new Error();
      if (
        !["committed", "modified", "unversioned", "unknown"].includes(
          source.source_state,
        )
      )
        throw new Error();
      if (
        source.source_state === "unknown"
          ? source.repository_revision !== null
          : typeof source.repository_revision !== "string" ||
            !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(source.repository_revision)
      )
        throw new Error();
      source_bytes += source.bytes;
    });
    if (
      source_bytes > provider.limits.total_source_bytes ||
      !Array.isArray(bundle.documents) ||
      !Array.isArray(manifest.documents) ||
      bundle.documents.length !== provider.documents.length ||
      manifest.documents.length !== provider.documents.length
    )
      throw new Error();
    const documents = bundle.documents.map((document, index) => {
      object(document, ["id", "text"]);
      const metadata = manifest.documents[index],
        declared = provider.documents[index];
      object(metadata, [
        "id",
        "source",
        "revision",
        "digest",
        "bytes",
        "format",
        "source_ids",
      ]);
      if (
        typeof document.text !== "string" ||
        document.id !== declared.id ||
        metadata.id !== declared.id ||
        metadata.source !== knowledge_source_id(provider, declared.id) ||
        metadata.digest !== digest(document.text) ||
        metadata.revision !== `v${metadata.digest}` ||
        metadata.bytes !== Buffer.byteLength(document.text) ||
        metadata.format !== declared.format ||
        canonical(metadata.source_ids) !== canonical(declared.source_ids)
      )
        throw new Error();
      return {
        id: document.id,
        text: document.text,
        source_ids: metadata.source_ids,
      };
    });
    validate_documents(provider, documents);
    if (
      digest(
        canonical({
          contract_version: bundle.contract_version,
          manifest,
          documents: bundle.documents,
        }),
      ) !== bundle.digest ||
      bundle_bytes(bundle).length > MAX_BUNDLE_BYTES
    )
      throw new Error();
    return bundle;
  } catch {
    bundle_fail("INVALID_KNOWLEDGE_BUNDLE");
  }
};
