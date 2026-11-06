import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { KnowledgeStore } from "./knowledge/storage.js";
import { create_knowledge_runtime } from "./knowledge/runtime.js";
import {
  start_app_reference_refresh,
  REFRESH_INTERVAL_MS,
} from "./subject_providers/refresh.js";
import { app_reference_definition } from "./app_reference/builtin.js";
import { fixture_bundle } from "./app_reference/fixtures.js";
import { create_app_chat_reference } from "./app_reference/chat.js";
import { create_skill_runtime } from "./skills/runtime.js";
import { executor_digest } from "./skills/executor.js";
import { read_ui_bundle } from "./subject_providers/reconcile.js";

const bundle = (word = "initial") =>
  fixture_bundle([
    {
      ...app_reference_definition.fixtures[0],
      text: `# Navigation\n\n## Purpose\nChat navigation ${word} reference.\n`,
    },
  ]);
const fixture = (t, options = {}) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fracto-refresh-"));
  const environment = {
    FRACTO_AI_KNOWLEDGE_DIR: path.join(directory, "knowledge"),
    FRACTO_AI_SKILL_DIR: path.join(directory, "skills"),
  };
  const opened = [];
  const track = (store) => {
    assert.ok(store);
    opened.push(store);
    return store;
  };
  const store = track(
    new KnowledgeStore(environment.FRACTO_AI_KNOWLEDGE_DIR, options),
  );
  t.after(() => {
    opened.forEach((item) => item.close());
    assert.equal(
      path.dirname(path.resolve(directory)),
      path.resolve(os.tmpdir()),
    );
    assert.ok(path.basename(directory).startsWith("fracto-refresh-"));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, environment, store, track };
};
const clock = () => {
  let callback,
    cleared = 0,
    unref = 0;
  const handle = {
    unref() {
      unref++;
    },
  };
  return {
    schedule: (run, interval) => {
      assert.equal(interval, REFRESH_INTERVAL_MS);
      callback = run;
      return handle;
    },
    unschedule: (value) => {
      assert.equal(value, handle);
      cleared++;
    },
    tick: () => callback(),
    get cleared() {
      return cleared;
    },
    get unref() {
      return unref;
    },
  };
};
const start = (store, read_bundle, extra = {}, environment = {}) =>
  start_app_reference_refresh(store, environment, {
    read_bundle,
    report_failure() {},
    ...extra,
  });

test("normal startup, periodic refresh and restart make current app information available to chat without manual publication", (t) => {
  const f = fixture(t),
    scheduler = clock();
  let current = bundle(),
    reads = 0;
  const runtime = f.track(
    create_knowledge_runtime(f.environment, {
      read_bundle: () => {
        reads++;
        return current;
      },
      ...scheduler,
    }),
  );
  const registry = f.track(create_skill_runtime(f.environment));
  const answer = create_app_chat_reference(f.environment);
  assert.ok(answer("chat").includes(current.digest));
  assert.equal(runtime.app_reference_refresh.status().state, "ready");
  assert.equal(scheduler.unref, 1);
  const before_time =
    runtime.bundle_status("ui-features").publication.published_at;
  const file = path.join(
    f.environment.FRACTO_AI_KNOWLEDGE_DIR,
    "knowledge.sqlite",
  );
  const before = fs.readFileSync(file);
  assert.equal(scheduler.tick().changed, false);
  assert.deepEqual(fs.readFileSync(file), before);
  current = bundle("updated");
  assert.equal(scheduler.tick().changed, true);
  assert.ok(answer("updated").includes("Chat navigation updated reference."));
  assert.ok(answer("updated").includes(current.digest));
  const revision_count = runtime.status().revisions;
  const latest_time =
    runtime.bundle_status("ui-features").publication.published_at;
  runtime.close();
  assert.equal(scheduler.cleared, 1);
  assert.equal(runtime.app_reference_refresh.run().state, "stopped");
  const restarted = f.track(
    create_knowledge_runtime(f.environment, {
      read_bundle: () => current,
      ...clock(),
    }),
  );
  assert.equal(restarted.status().revisions, revision_count);
  assert.equal(
    restarted.bundle_status("ui-features").publication.published_at,
    latest_time,
  );
  assert.equal(
    restarted.bundle_refresh_status("ui-features").digest,
    current.digest,
  );
  assert.ok(
    restarted.bundle_status("ui-features").publication.published_at >=
      before_time,
  );
  registry.select("app-reference", null, "1.0.0", executor_digest());
  registry.close();
  f.track(create_skill_runtime(f.environment));
  assert.throws(() => answer("chat"), /SKILL_DISABLED/);
  assert.equal(reads, 3);
});

test("late publication failure rolls back documents, staging head and refresh ownership together", (t) => {
  const { store } = fixture(t);
  const first = bundle();
  store.refresh_bundle(first);
  const next = bundle("changed");
  store.db.exec(
    "CREATE TRIGGER reject_refresh BEFORE UPDATE ON bundle_publications BEGIN SELECT RAISE(ABORT,'fixture-failure'); END",
  );
  const runner = start(store, () => next, clock());
  assert.equal(runner.status().state, "unavailable");
  assert.equal(store.bundle_status("ui-features").digest, first.digest);
  assert.equal(store.bundle_refresh_status("ui-features").digest, first.digest);
  assert.equal(
    store.published_bundle("ui-features").bundle.digest,
    first.digest,
  );
  assert.equal(store.status().revisions, 1);
  store.db.exec("DROP TRIGGER reject_refresh");
  assert.equal(runner.run().changed, true);
  assert.equal(
    store.published_bundle("ui-features").bundle.digest,
    next.digest,
  );
  runner.close();
});

test("missing, partial or corrupt artifact retains the last good publication, reports only state transitions and recovers", (t) => {
  const { store } = fixture(t);
  const first = bundle();
  store.refresh_bundle(first);
  let current = structuredClone(first),
    reports = 0;
  current.documents.pop();
  const runner = start(store, () => current, {
    ...clock(),
    report_failure: () => reports++,
  });
  const file = path.join(store.directory, "knowledge.sqlite");
  const before = fs.readFileSync(file);
  assert.equal(runner.status().state, "unavailable");
  assert.equal(runner.run().state, "unavailable");
  assert.equal(reports, 1);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(
    store.published_bundle("ui-features").bundle.digest,
    first.digest,
  );
  current = bundle("recovered");
  assert.equal(runner.run().state, "ready");
  runner.close();
  const missing = start(
    store,
    () => {
      throw new Error("private path and source contents");
    },
    { ...clock(), report_failure: () => reports++ },
  );
  assert.deepEqual(missing.status(), { state: "unavailable", changed: false });
  assert.equal(
    store.published_bundle("ui-features").bundle.digest,
    current.digest,
  );
  assert.equal(reports, 2);
  missing.close();
});

test("operator edits and retirements remain authoritative across automatic refresh and reopened stores", (t) => {
  for (const operation of ["put", "retire"]) {
    const f = fixture(t);
    const first = bundle();
    f.store.refresh_bundle(first);
    const source = first.manifest.documents[0];
    if (operation === "put")
      f.store.put(
        source.source,
        "local",
        "Local reference override.",
        source.revision,
      );
    else f.store.retire(source.source, source.revision);
    f.store.close();
    const reopened = f.track(
      new KnowledgeStore(f.environment.FRACTO_AI_KNOWLEDGE_DIR),
    );
    const runner = start(reopened, () => bundle("new"), clock());
    assert.equal(runner.status().state, "operator_override");
    assert.throws(
      () => reopened.published_bundle("ui-features"),
      /BUNDLE_PUBLICATION_DISABLED/,
    );
    assert.equal(reopened.bundle_status("ui-features").digest, first.digest);
    assert.equal(
      reopened.bundle_refresh_status("ui-features").digest,
      first.digest,
    );
    assert.equal(
      reopened.current(source.source).retired,
      operation === "retire" ? 1 : 0,
    );
    if (operation === "put")
      assert.equal(
        reopened.get(source.source).text,
        "Local reference override.",
      );
    runner.close();
  }
});

test("operator staging or publication changes stop automatic advancement rather than racing their selection", (t) => {
  const { store } = fixture(t);
  const first = bundle(),
    second = bundle("manual"),
    third = bundle("automatic");
  store.refresh_bundle(first);
  store.reconcile_bundle(second);
  const runner = start(store, () => third, clock());
  assert.equal(runner.status().state, "operator_override");
  assert.equal(store.bundle_status("ui-features").digest, second.digest);
  store.publish_bundle("ui-features", second.digest, first.digest);
  assert.equal(runner.run().state, "operator_override");
  assert.equal(
    store.published_bundle("ui-features").bundle.digest,
    second.digest,
  );
  assert.throws(
    () => store.adopt_bundle_refresh("ui-features", second.digest),
    /BUNDLE_REFRESH_CONFLICT/,
  );
  store.adopt_bundle_refresh("ui-features", second.digest, first.digest);
  assert.equal(runner.run().state, "ready");
  assert.equal(
    store.published_bundle("ui-features").bundle.digest,
    third.digest,
  );
  runner.close();
});

test("first bootstrap preserves different manual publications and safely adopts an identical verified build", (t) => {
  const { store } = fixture(t);
  const first = bundle(),
    next = bundle("new");
  store.reconcile_bundle(first);
  store.publish_bundle("ui-features", first.digest);
  const runner = start(store, () => next, clock());
  assert.equal(runner.status().state, "operator_override");
  assert.equal(store.bundle_refresh_status("ui-features"), null);
  runner.close();
  assert.equal(store.refresh_bundle(first).state, "ready");
  assert.equal(store.refresh_bundle(next).state, "ready");
});

test("a formerly seen old build cannot roll the managed snapshot backwards", (t) => {
  const { store } = fixture(t);
  const first = bundle(),
    next = bundle("new");
  store.refresh_bundle(first);
  store.refresh_bundle(next);
  const runner = start(store, () => first, clock());
  assert.equal(runner.status().state, "unavailable");
  assert.equal(
    store.published_bundle("ui-features").bundle.digest,
    next.digest,
  );
  assert.equal(store.bundle_refresh_status("ui-features").digest, next.digest);
  runner.close();
});

test("removals and reintroduction publish complete generations without reviving explicit operator retirement", (t) => {
  const { store } = fixture(t);
  const first = fixture_bundle([
    ...app_reference_definition.fixtures,
    {
      source: "app-11-ui-features-extra",
      text: "# Extra\n\n## Purpose\nExtra app reference.\n",
    },
  ]);
  store.refresh_bundle(first);
  const removed = bundle("removed-extra");
  store.refresh_bundle(removed);
  assert.equal(
    store.published_bundle("ui-features").bundle.documents.length,
    1,
  );
  const restored = fixture_bundle(
    first.documents.map((document, index) => ({
      source: first.manifest.documents[index].source,
      text: document.text + "\nRestored.\n",
    })),
  );
  store.refresh_bundle(restored);
  assert.equal(
    store.published_bundle("ui-features").bundle.documents.length,
    2,
  );
  const source = restored.manifest.documents[0];
  store.retire(source.source, source.revision);
  const next = bundle("operator-retired");
  assert.equal(store.refresh_bundle(next).state, "operator_override");
  assert.equal(store.current(source.source).retired, 1);
});

test("disabled or malformed refresh configuration leaves knowledge usable and creates no poller or app publication", (t) => {
  for (const setting of ["false", "invalid"]) {
    const f = fixture(t);
    let reads = 0,
      scheduled = 0;
    const runtime = f.track(
      create_knowledge_runtime(
        { ...f.environment, FRACTO_AI_APP_REFERENCE_REFRESH: setting },
        {
          read_bundle: () => {
            reads++;
            return bundle();
          },
          schedule: () => scheduled++,
          report_failure() {},
        },
      ),
    );
    assert.equal(runtime.status().state, "ready");
    assert.equal(runtime.status().sources, 4);
    assert.equal(reads, 0);
    assert.equal(scheduled, 0);
    assert.equal(
      runtime.app_reference_refresh.status().state,
      setting === "false" ? "disabled" : "unavailable",
    );
  }
});

test("schema-three migration preserves a manual snapshot without inventing automatic ownership", (t) => {
  const f = fixture(t),
    first = bundle();
  f.store.reconcile_bundle(first);
  f.store.publish_bundle("ui-features", first.digest);
  f.store.db.exec("DROP TABLE bundle_refresh; PRAGMA user_version=3");
  f.store.close();
  const reader = f.track(
    new KnowledgeStore(f.environment.FRACTO_AI_KNOWLEDGE_DIR, {
      read_only: true,
    }),
  );
  assert.equal(reader.bundle_refresh_status("ui-features"), null);
  reader.close();
  const migrated = f.track(
    new KnowledgeStore(f.environment.FRACTO_AI_KNOWLEDGE_DIR),
  );
  assert.equal(migrated.bundle_refresh_status("ui-features"), null);
  assert.equal(
    migrated.published_bundle("ui-features").bundle.digest,
    first.digest,
  );
  assert.equal(migrated.refresh_bundle(first).state, "ready");
});

test("disk and snapshot capacity failure keep the managed publication complete and unchanged", (t) => {
  let free = 2 * 1024 ** 3;
  const { store } = fixture(t, { free_disk: () => free });
  const first = bundle(),
    next = bundle("new");
  store.refresh_bundle(first);
  free = 0;
  assert.equal(store.refresh_bundle(first).changed, false);
  assert.throws(() => store.refresh_bundle(next), /DISK_PRESSURE/);
  assert.equal(
    store.published_bundle("ui-features").bundle.digest,
    first.digest,
  );
  free = 2 * 1024 ** 3;
  store.transaction(() => {
    for (let index = 0; index < 999; index++)
      store.db
        .prepare("INSERT INTO bundle_snapshots VALUES(?,?,?,?,?)")
        .run("fixture", String(index), "{}", 0, "{}");
  });
  assert.throws(() => store.refresh_bundle(next), /BUNDLE_CAPACITY/);
  assert.equal(store.bundle_status("ui-features").digest, first.digest);
  assert.equal(store.bundle_refresh_status("ui-features").digest, first.digest);
});

test(
  "the actual prepared bundle automatically seeds a fresh runtime and answers chat with its snapshot digest",
  {
    skip: !fs.existsSync(
      new URL("./generated/knowledge/ui-features.bundle.json", import.meta.url),
    ),
  },
  (t) => {
    const f = fixture(t),
      current = read_ui_bundle();
    const runtime = f.track(create_knowledge_runtime(f.environment, clock()));
    f.track(create_skill_runtime(f.environment));
    assert.equal(
      runtime.published_bundle("ui-features").bundle.documents.length,
      7,
    );
    assert.ok(
      create_app_chat_reference(f.environment)("chat").includes(current.digest),
    );
  },
);
