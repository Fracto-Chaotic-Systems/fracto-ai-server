import { KnowledgeStore, KnowledgeError, read_document } from "./storage.js";
import { knowledge_directory } from "./runtime.js";

let store;
try {
  const [command, ...args] = process.argv.slice(2);
  const counts = {
    status: [0],
    list: [0, 1],
    put: [3, 4],
    get: [1, 2],
    search: [1],
    retire: [2],
  };
  if (!counts[command]?.includes(args.length))
    throw new KnowledgeError("INVALID_COMMAND");
  store = new KnowledgeStore(knowledge_directory());
  let result;
  if (command === "status") result = store.status();
  if (command === "list") result = store.list(args[0] ?? "");
  if (command === "put")
    result = store.put(
      args[0],
      args[1],
      read_document(args[2]),
      args[3] ?? null,
    );
  if (command === "get") result = store.get(args[0], args[1] ?? null);
  if (command === "search") result = store.search(args[0]);
  if (command === "retire") result = store.retire(args[0], args[1]);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(
    JSON.stringify({
      error:
        error instanceof KnowledgeError ? error.code : "KNOWLEDGE_UNAVAILABLE",
    }),
  );
  process.exitCode = 1;
} finally {
  store?.close();
}
