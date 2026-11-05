import fs from "node:fs";
import path from "node:path";
import {
  explain_infrastructure,
  question_terms,
} from "../infrastructure/reference.js";
import { fail, hash, validate_input, profile_for } from "./contracts.js";
import { scan_environment_assets } from "../data_quality/scan.js";

const fingerprint = hash(
  [
    "contracts.js",
    "executor.js",
    "evaluate.js",
    "storage.js",
    "../infrastructure/reference.js",
    "../knowledge/storage.js",
    "../data_quality/contracts.js",
    "../data_quality/scan.js",
    "../data_quality/builtin.js",
  ]
    .map((file) =>
      fs
        .readFileSync(path.join(import.meta.dirname, file), "utf8")
        .replace(/\r\n/g, "\n"),
    )
    .join("\n"),
);
export const executor_digest = () => fingerprint;
export const execute = (definition, input, reader) => {
  const profile = profile_for(definition.executor);
  if (
    definition.skill_id !== profile.id ||
    definition.permissions.length !== 1 ||
    definition.permissions[0] !== profile.permission
  )
    fail("EXECUTOR_UNAVAILABLE");
  validate_input(input, definition.executor);
  let result;
  if (definition.executor === "environment-asset-quality-v1")
    result = scan_environment_assets(input);
  else {
    question_terms(input.question);
    if (!reader?.read_only) fail("READ_ONLY_REQUIRED");
    result = explain_infrastructure(reader, input.question);
  }
  if (!profile.validate_output(result)) fail("INVALID_SKILL_OUTPUT");
  return result;
};
export const run_active = (registry, id, input, reader) => {
  const release = registry.resolve(id, executor_digest());
  const result = execute(release.definition, input, reader);
  return {
    ...result,
    registry: {
      version: release.version,
      definition_digest: release.digest,
      executor_digest: release.evaluation.executor_digest,
    },
  };
};
