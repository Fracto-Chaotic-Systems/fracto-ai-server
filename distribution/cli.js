import path from "node:path";
import { peer_directory } from "../peers/configuration.js";
import { validate_identity } from "../peers/identity.js";
import { read_json } from "../peers/files.js";
import { KnowledgeStore } from "../knowledge/storage.js";
import { knowledge_directory } from "../knowledge/runtime.js";
import { SkillRegistry } from "../skills/storage.js";
import { skill_directory } from "../skills/runtime.js";
import { DistributionStore } from "./storage.js";
import { DistributionError, fail } from "./contracts.js";
import { adopt_knowledge, adopt_skill } from "./adopt.js";

let store, knowledge, registry;
try {
  const [command, ...args] = process.argv.slice(2),
    counts = {
      status: [0],
      list: [0, 1],
      get: [1],
      "publish-knowledge": [3],
      "publish-skill": [3],
      "adopt-knowledge": [3],
      "adopt-skill": [1],
      relay: [2],
      withdraw: [1],
      adoptions: [0],
    };
  if (!Object.hasOwn(counts, command) || !counts[command].includes(args.length))
    fail("INVALID_DISTRIBUTION_COMMAND");
  if (
    ["publish-knowledge", "publish-skill", "relay"].includes(command) &&
    args.at(-1) !== "--approved-nonpersonal"
  )
    fail("PUBLICATION_REVIEW_REQUIRED");
  const directory = peer_directory(),
    identity = validate_identity(
      read_json(path.join(directory, "identity.json"), 32768),
    );
  store = new DistributionStore(
    path.join(directory, "distribution"),
    identity.node_id,
    { read_only: ["status", "list", "get", "adoptions"].includes(command) },
  );
  let result;
  if (command === "status") result = store.status();
  if (command === "list") result = store.list(args[0] ?? "");
  if (command === "get") result = store.get(args[0]);
  if (command === "adoptions") result = store.adoptions();
  if (command === "publish-knowledge") {
    knowledge = new KnowledgeStore(knowledge_directory(), { read_only: true });
    const doc = knowledge.get(args[0], args[1]);
    if (knowledge.current(args[0])?.retired) fail("SOURCE_RETIRED");
    result = store.publish("knowledge", {
      source: doc.source,
      revision: doc.revision,
      content_digest: doc.digest,
      text: doc.text,
    });
  }
  if (command === "publish-skill") {
    registry = new SkillRegistry(skill_directory(), { read_only: true });
    const release = registry.get(args[0], args[1]);
    result = store.publish("skill", {
      definition: release.definition,
      definition_digest: release.digest,
    });
  }
  if (command === "adopt-knowledge") {
    knowledge = new KnowledgeStore(knowledge_directory());
    result = adopt_knowledge(
      store,
      args[0],
      knowledge,
      args[1],
      args[2] === "none" ? null : args[2],
    );
  }
  if (command === "adopt-skill") {
    registry = new SkillRegistry(skill_directory());
    result = adopt_skill(store, args[0], registry);
  }
  if (command === "relay") result = store.relay(args[0]);
  if (command === "withdraw") result = store.withdraw(args[0]);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(
    JSON.stringify({
      error:
        error instanceof DistributionError
          ? error.code
          : "DISTRIBUTION_UNAVAILABLE",
    }),
  );
  process.exitCode = 1;
} finally {
  registry?.close();
  knowledge?.close();
  store?.close();
}
