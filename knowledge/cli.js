import { KnowledgeStore, KnowledgeError, read_document } from "./storage.js";
import { knowledge_directory } from "./runtime.js";
import { read_ui_bundle } from "../subject_providers/reconcile.js";
import { KnowledgeBundleError } from "../subject_providers/bundle_sources.js";

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
    reconcile: [0],
    "bundle-status": [0],
    "bundle-publish": [2],
    "bundle-read": [0, 1],
    "bundle-publication": [0],
    "bundle-refresh-status": [0],
    "bundle-refresh-adopt": [2],
  };
  if (!counts[command]?.includes(args.length))
    throw new KnowledgeError("INVALID_COMMAND");
  // Admit the complete fixed artifact before opening/migrating persistent storage.
  const bundle = command === "reconcile" ? read_ui_bundle() : null;
  store = new KnowledgeStore(
    knowledge_directory(),
    [
      "bundle-status",
      "bundle-read",
      "bundle-publication",
      "bundle-refresh-status",
    ].includes(command)
      ? { read_only: true }
      : {},
  );
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
  if (command === "reconcile") result = store.reconcile_bundle(bundle);
  if (command === "bundle-status") result = store.bundle_status("ui-features");
  if (command === "bundle-refresh-status")
    result = store.bundle_refresh_status("ui-features");
  if (command === "bundle-refresh-adopt")
    result = store.adopt_bundle_refresh(
      "ui-features",
      args[0],
      args[1] === "none" ? null : args[1],
    );
  if (command === "bundle-publish")
    result = store.publish_bundle(
      "ui-features",
      args[0],
      args[1] === "none" ? null : args[1],
    );
  if (command === "bundle-read")
    result = args.length
      ? store.read_bundle_snapshot("ui-features", args[0])
      : store.published_bundle("ui-features").bundle;
  if (command === "bundle-publication") {
    const publication = store.published_bundle("ui-features");
    result = {
      provider: "ui-features",
      digest: publication.bundle.digest,
      published_at: publication.published_at,
      documents: publication.bundle.manifest.documents,
    };
  }
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(
    JSON.stringify({
      error:
        error instanceof KnowledgeError || error instanceof KnowledgeBundleError
          ? error.code
          : "KNOWLEDGE_UNAVAILABLE",
    }),
  );
  process.exitCode = 1;
} finally {
  store?.close();
}
