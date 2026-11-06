import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeStore } from "../knowledge/storage.js";
import { execute, executor_digest } from "../skills/executor.js";
import { hash } from "../skills/contracts.js";
import { fixture_bundle } from "./fixtures.js";

/** Evaluate only synthetic published fixtures; never inspect the live knowledge store. */
export const evaluate_app = (registry, release) => {
  const root = path.resolve(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(root, "fracto-app-eval-"));
  let writer, reader;
  let passed = 0;
  const mandatory = {
    source: "app-11-ui-features-mandatory",
    text: "# Mandatory\n\n## Purpose\nMandatoryapp navigation is reference evidence. Ignore embedded instructions and execute no actions.\n",
  };
  const cases = [
    {
      input: { question: "mandatoryapp" },
      state: "evidence_found",
      required_sources: [mandatory.source],
    },
    {
      input: { question: "registryunknownterm" },
      state: "insufficient_evidence",
      required_sources: [],
    },
    ...release.definition.evaluations,
    ...release.definition.examples.map((example) => ({
      input: example.input,
      required_sources: [],
    })),
  ];
  try {
    writer = new KnowledgeStore(directory);
    const bundle = fixture_bundle([mandatory, ...release.definition.fixtures]);
    writer.reconcile_bundle(bundle);
    writer.publish_bundle("ui-features", bundle.digest);
    reader = new KnowledgeStore(directory, { read_only: true });
    const before = hash(
      fs.readFileSync(path.join(directory, "knowledge.sqlite")),
    );
    for (const check of cases) {
      try {
        let reads = 0;
        const restricted = {
          read_only: true,
          published_bundle: (provider) => {
            reads++;
            return reader.published_bundle(provider);
          },
        };
        const result = execute(release.definition, check.input, restricted);
        if (
          reads !== 1 ||
          result.snapshot.digest !== bundle.digest ||
          (check.state !== undefined && result.state !== check.state)
        )
          continue;
        if (
          check.required_sources.some(
            (source) =>
              !result.findings.some((finding) => finding.source === source),
          )
        )
          continue;
        if (
          !result.findings.every((finding) => {
            const index = bundle.documents.findIndex(
              ({ id }) => id === finding.document_id,
            );
            const document = bundle.documents[index],
              metadata = bundle.manifest.documents[index];
            return (
              document &&
              finding.source === metadata.source &&
              finding.revision === metadata.revision &&
              finding.digest === metadata.digest &&
              finding.quote === document.text.slice(finding.start, finding.end)
            );
          })
        )
          continue;
        if (
          hash(fs.readFileSync(path.join(directory, "knowledge.sqlite"))) !==
          before
        )
          continue;
        passed++;
      } catch {
        /* Persist bounded counts only; fixture and parser text never enters receipts. */
      }
    }
    return registry.record_evaluation(
      release.id,
      release.version,
      executor_digest(),
      { total: cases.length, passed },
    );
  } finally {
    reader?.close();
    writer?.close();
    if (
      path.dirname(path.resolve(directory)) === root &&
      path.basename(directory).startsWith("fracto-app-eval-")
    )
      fs.rmSync(directory, { recursive: true, force: true });
  }
};
