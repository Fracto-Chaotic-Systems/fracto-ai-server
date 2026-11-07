import { question_terms } from "../infrastructure/reference.js";
import { fail } from "../skills/contracts.js";

const words = (text) => text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
const matches = (text, terms) => {
  const tokens = new Set(words(text));
  return terms
    .filter((group) => group.alternatives.some((term) => tokens.has(term)))
    .map((group) => group.term);
};

/** One published snapshot, exact passages only; documents never grant operations. */
export const explain_app = (reader, question) => {
  const terms = question_terms(question);
  if (!reader?.read_only) fail("READ_ONLY_REQUIRED");
  let publication;
  try {
    // Pin exactly once. Never join against current sources or unscoped knowledge search.
    publication = reader.published_bundle("ui-features");
    if (publication.bundle.manifest.provider.subject_id !== "application-ui")
      throw new Error();
  } catch {
    fail("APP_REFERENCE_UNAVAILABLE");
  }
  const { bundle, published_at } = publication;
  const ranked = [];
  for (let index = 0; index < bundle.documents.length; index++) {
    const document = bundle.documents[index],
      metadata = bundle.manifest.documents[index];
    for (
      let start = 0, chunk = 0;
      start < document.text.length;
      start += 1800, chunk++
    ) {
      const text = document.text.slice(start, start + 2000);
      if (!matches(text, terms).length) continue;
      const match = [...text.matchAll(/[\p{L}\p{N}_]+/gu)].find((item) =>
        terms.some((group) =>
          group.alternatives.includes(item[0].toLowerCase()),
        ),
      );
      const begin = Math.max(
        text.lastIndexOf("\n", match.index) + 1,
        match.index - 150,
      );
      const quote = text.slice(begin, begin + 600);
      const matched_terms = matches(quote, terms);
      if (matched_terms.length)
        ranked.push({
          document_id: document.id,
          source: metadata.source,
          revision: metadata.revision,
          digest: metadata.digest,
          chunk,
          start: start + begin,
          end: start + begin + quote.length,
          quote,
          matched_terms,
        });
    }
  }
  ranked.sort(
    (a, b) =>
      b.matched_terms.length - a.matched_terms.length ||
      (a.document_id < b.document_id
        ? -1
        : a.document_id > b.document_id
          ? 1
          : 0) ||
      a.chunk - b.chunk,
  );
  const findings = ranked
    .slice(0, 5)
    .map((finding, index) => ({ citation: index + 1, ...finding }));
  const matched = new Set(findings.flatMap((finding) => finding.matched_terms));
  return {
    contract_version: 1,
    skill: "app-reference",
    skill_version: 1,
    answer_type: "extractive_reference",
    state: findings.length ? "evidence_found" : "insufficient_evidence",
    evidence_only: true,
    live_verified: false,
    snapshot: {
      provider: "ui-features",
      subject: "application-ui",
      digest: bundle.digest,
      provider_digest: bundle.manifest.provider_digest,
      published_at,
    },
    findings,
    unmatched_terms: terms
      .map((group) => group.term)
      .filter((term) => !matched.has(term)),
    limits: { findings: 5, quote_characters: 600, question_terms: 12 },
  };
};
