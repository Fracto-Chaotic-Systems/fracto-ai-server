import { KnowledgeError } from "../knowledge/storage.js";

const stop = new Set(
  "a an and are as at be can could do does explain for from how i in is it me of on or please should tell that the their there these this to use uses using what when where which who why will with would".split(
    " ",
  ),
);
const aliases = {
  mesh: ["mesh", "meshes"],
  meshes: ["mesh", "meshes"],
  tile: ["tile", "tiles"],
  tiles: ["tile", "tiles"],
  render: ["render", "renders", "rendering"],
  renderer: ["render", "renders", "rendering"],
  rendering: ["render", "renders", "rendering"],
  owns: ["owns", "ownership"],
  ownership: ["owns", "ownership"],
  server: ["server", "servers", "service"],
  servers: ["server", "servers", "service"],
};
const words = (text) => text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
export const question_terms = (question) => {
  if (
    typeof question !== "string" ||
    question.length > 512 ||
    Buffer.byteLength(question) > 1024 ||
    /[\x00-\x1f]/.test(question)
  )
    throw new KnowledgeError("INVALID_QUESTION");
  const terms = [...new Set(words(question).filter((word) => !stop.has(word)))];
  if (!terms.length || terms.length > 12)
    throw new KnowledgeError("INVALID_QUESTION");
  return terms.map((term) => ({
    term,
    alternatives: Object.hasOwn(aliases, term) ? aliases[term] : [term],
  }));
};

/** Extractive reference answers; text never becomes executable instructions. */
export const explain_infrastructure = (reader, question) => {
  const terms = question_terms(question);
  return reader.snapshot(() => {
    const candidates = new Map();
    for (const group of terms) {
      for (const term of group.alternatives) {
        for (const hit of reader.search(term)) {
          candidates.set(`${hit.source}:${hit.revision}:${hit.chunk}`, hit);
        }
      }
    }
    const ranked = [];
    for (const hit of candidates.values()) {
      const document = reader.get(hit.source, hit.revision);
      const start = Number(hit.chunk) * 1800;
      const text = document.text.slice(start, start + 2000);
      const tokens = new Set(words(text));
      const matched = terms
        .filter((group) => group.alternatives.some((term) => tokens.has(term)))
        .map((group) => group.term);
      if (matched.length) ranked.push({ hit, document, start, text, matched });
    }
    ranked.sort(
      (a, b) =>
        b.matched.length - a.matched.length ||
        a.hit.source.localeCompare(b.hit.source) ||
        Number(a.hit.chunk) - Number(b.hit.chunk),
    );
    const findings = [];
    for (const candidate of ranked) {
      if (findings.length === 5) break;
      const { hit, document, start, text } = candidate;
      // Prefer a complete passage near the first matching word, bounded to 600 chars.
      const match = [...text.matchAll(/[\p{L}\p{N}_]+/gu)].find((item) =>
        terms.some((group) =>
          group.alternatives.includes(item[0].toLowerCase()),
        ),
      );
      const paragraph = text.lastIndexOf("\n", match.index) + 1;
      const begin = Math.max(paragraph, match.index - 150);
      const quote = text.slice(begin, begin + 600);
      const quoted_tokens = new Set(words(quote));
      const matched_terms = terms
        .filter((group) =>
          group.alternatives.some((term) => quoted_tokens.has(term)),
        )
        .map((group) => group.term);
      if (!matched_terms.length) continue;
      findings.push({
        citation: findings.length + 1,
        quote,
        matched_terms,
        source: hit.source,
        revision: hit.revision,
        digest: document.digest,
        chunk: Number(hit.chunk),
        start: start + begin,
        end: start + begin + quote.length,
      });
    }
    const matched = new Set(
      findings.flatMap((finding) => finding.matched_terms),
    );
    return {
      contract_version: 1,
      skill: "infrastructure-reference",
      skill_version: 1,
      answer_type: "extractive_reference",
      state: findings.length ? "evidence_found" : "insufficient_evidence",
      evidence_only: true,
      live_verified: false,
      findings,
      unmatched_terms: terms
        .map((group) => group.term)
        .filter((term) => !matched.has(term)),
      limits: { findings: 5, quote_characters: 600, question_terms: 12 },
    };
  });
};
