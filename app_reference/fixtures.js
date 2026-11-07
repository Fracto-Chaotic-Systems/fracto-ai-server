import {
  validate_provider,
  provider_digest,
  knowledge_source_id,
} from "../subject_providers/contracts.js";
import { validate_bundle } from "../subject_providers/bundle_contract.js";
import { canonical } from "../subject_providers/validation.js";
import { digest } from "../subject_providers/bundle_sources.js";

/** Synthetic evaluation data only; never reads the deployed artifact or UI checkout. */
export const fixture_bundle = (fixtures) => {
  const prefix = "app-11-ui-features-";
  if (fixtures.some(({ source }) => !source.startsWith(prefix)))
    throw new Error("INVALID_APP_FIXTURE");
  const provider = validate_provider({
    contract_version: 1,
    provider_id: "ui-features",
    subject_id: "application-ui",
    extractor: { id: "ui-catalog", version: "1.0.0" },
    sources: [
      { id: "catalog", repository: "ui", path: "src/features/catalog.json" },
    ],
    documents: fixtures.map(({ source }) => ({
      id: source.slice(prefix.length),
      source_ids: ["catalog"],
      format: "markdown",
      validation: {
        profile: "reference-text-v1",
        required_sections: ["Purpose"],
      },
    })),
    limits: {
      source_bytes: 1024,
      total_source_bytes: 1024,
      document_bytes: 65536,
      total_document_bytes: 1048576,
    },
  });
  const documents = provider.documents.map(({ id }) => ({
    id,
    text: fixtures.find(
      ({ source }) => source === knowledge_source_id(provider, id),
    ).text,
  }));
  const result = {
    contract_version: 1,
    manifest: {
      provider,
      provider_digest: provider_digest(provider),
      generator: {
        id: "subject-bundle",
        version: "1.0.0",
        fingerprint: "a".repeat(64),
      },
      extractor: { ...provider.extractor, fingerprint: "b".repeat(64) },
      sources: provider.sources.map((source) => ({
        ...source,
        digest: digest("synthetic app reference"),
        bytes: Buffer.byteLength("synthetic app reference"),
        repository_revision: null,
        source_state: "unknown",
      })),
      documents: documents.map((document) => ({
        id: document.id,
        source: knowledge_source_id(provider, document.id),
        revision: `v${digest(document.text)}`,
        digest: digest(document.text),
        bytes: Buffer.byteLength(document.text),
        format: "markdown",
        source_ids: ["catalog"],
      })),
    },
    documents,
  };
  return validate_bundle({ ...result, digest: digest(canonical(result)) });
};
