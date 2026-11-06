import { KnowledgeStore } from "../knowledge/storage.js";
import { knowledge_directory } from "../knowledge/runtime.js";
import { SkillRegistry } from "../skills/storage.js";
import { skill_directory } from "../skills/runtime.js";
import { run_active } from "../skills/executor.js";

const literal_block = (text) => {
  const longest = Math.max(
    0,
    ...[...text.matchAll(/`+/g)].map(([run]) => run.length),
  );
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text}\n${fence}`;
};

/** Deterministic cited answer; source text is never sent to a model or executed. */
export const format_app_reference = (report) => {
  const lines = [
    "App reference — published documentation; not a live verification.",
  ];
  if (!report.findings.length)
    lines.push(
      "No matching passages were found in the published app reference.",
    );
  for (const finding of report.findings) {
    lines.push(
      `### [${finding.citation}] ${finding.document_id}`,
      literal_block(finding.quote),
      `Source: \`${finding.source}\`; revision: \`${finding.revision}\`; characters ${finding.start}–${finding.end}.`,
    );
  }
  if (report.unmatched_terms.length)
    lines.push(
      `Terms without cited matches: ${report.unmatched_terms.map((term) => `\`${term}\``).join(", ")}.`,
    );
  lines.push(
    `Snapshot: \`${report.snapshot.digest}\`.`,
    `Skill: \`app-reference\` ${report.registry.version}; definition: \`${report.registry.definition_digest}\`; executor: \`${report.registry.executor_digest}\`.`,
  );
  return lines.join("\n\n");
};

/** Open existing stores read-only per request; no bootstrapping or initialization here. */
export const create_app_chat_reference =
  (environment = process.env) =>
  (question) => {
    let registry, reader;
    try {
      registry = new SkillRegistry(skill_directory(environment), {
        read_only: true,
      });
      reader = new KnowledgeStore(knowledge_directory(environment), {
        read_only: true,
      });
      return format_app_reference(
        run_active(registry, "app-reference", { question }, reader),
      );
    } finally {
      reader?.close();
      registry?.close();
    }
  };
