import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { once } from "node:events";
import { KnowledgeStore } from "../knowledge/storage.js";
import { create_skill_runtime } from "../skills/runtime.js";
import { executor_digest } from "../skills/executor.js";
import { app_reference_definition } from "../app_reference/builtin.js";
import { fixture_bundle } from "../app_reference/fixtures.js";
import { create_app_chat_reference } from "../app_reference/chat.js";
import { InferenceService } from "../inference/service.js";
import { create_app } from "../app.js";
import {launch_service_fixture}from"@fracto/sdk/testing/ServiceFixture.js";
import {fileURLToPath}from"node:url";
import { stream_chat } from "@fracto/sdk/chat/ChatClient.js";


// Fixture mutations perform synchronous durable writes between HTTP requests.
// Fresh connections avoid reusing idle sockets whose close events were delayed.
const fixture_fetch = (url, options = {}) => {
  const headers = new Headers(options.headers);
  headers.set("Connection", "close");
  return fetch(url, { ...options, headers });
};

const token = "a".repeat(64);
const body = (content = "chat navigation") => ({
  contract_version: 1,
  mode: "app-reference",
  messages: [{ role: "user", content }],
});
const collect = async (iterator) => {
  const values = [];
  for await (const value of iterator) values.push(value);
  return values;
};
const fixture = async (
  t,
  { publish = true, fixtures = app_reference_definition.fixtures } = {},
) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "fracto-chat-reference-"),
  );
  const environment = {
    FRACTO_AI_KNOWLEDGE_DIR: path.join(directory, "knowledge"),
    FRACTO_AI_SKILL_DIR: path.join(directory, "skills"),
  };
  const knowledge = new KnowledgeStore(environment.FRACTO_AI_KNOWLEDGE_DIR);
  const registry = create_skill_runtime(environment);
  assert.ok(registry);
  const bundle = fixture_bundle(fixtures);
  if (publish) {
    knowledge.reconcile_bundle(bundle);
    knowledge.publish_bundle("ui-features", bundle.digest);
  }
  let models = 0,
    writes = 0,
    reads = 0;
  const reference = create_app_chat_reference(environment);
  const service = new InferenceService({
    store: {
      token,
      all: () => [],
      maintain() {},
      close() {},
      free_bytes: () => 0,
      insert() {
        writes++;
      },
      artifact() {
        writes++;
      },
      save() {
        writes++;
      },
    },
    adapter: {
      generate() {
        models++;
        throw new Error("Model must not run");
      },
      stream() {
        models++;
        throw new Error("Model must not run");
      },
    },
    free_memory: () => 0,
    poll_ms: 60000,
    app_reference: (question) => {
      reads++;
      return reference(question);
    },
  });
  const ai = create_app({ inference: service }).listen(0, "127.0.0.1");
  await once(ai, "listening");
  const admin=await launch_service_fixture(fileURLToPath(new URL("../../fracto-admin-server/test/chat_fixture.mjs",import.meta.url)),{port:ai.address().port,token,require_cookie:true},t);
  t.after(async () => {
    await service.close();
    await Promise.all([
      admin.close(),
      new Promise((resolve) => ai.close(resolve)),
    ]);
    registry.close();
    knowledge.close();
    assert.equal(
      path.dirname(path.resolve(directory)),
      path.resolve(os.tmpdir()),
    );
    assert.ok(path.basename(directory).startsWith("fracto-chat-reference-"));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const url = admin.base+"/chat";
  return {
    service,
    knowledge,
    registry,
    directory,
    environment,
    bundle,
    url,
    get counts() {
      return { models, writes, reads, credential_reads:admin.sync("stats").credential_reads };
    },
    request: (value = body(), headers = {}) =>
      fixture_fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          cookie: "session=admin",
          ...headers,
        },
        body: JSON.stringify(value),
      }),
  };
};

test("reference mode traverses browser stream, admin bridge and active skill with exact citations and no model or database writes", async (t) => {
  const f = await fixture(t);
  const files = [
    path.join(f.environment.FRACTO_AI_KNOWLEDGE_DIR, "knowledge.sqlite"),
    path.join(f.environment.FRACTO_AI_SKILL_DIR, "skills.sqlite"),
  ];
  const before = files.map((file) => fs.readFileSync(file));
  const values = await collect(
    stream_chat(
      f.url,
      body().messages,
      undefined,
      (url, options) =>
        fixture_fetch(url, {
          ...options,
          headers: { ...options.headers, cookie: "session=admin" },
        }),
      "app-reference",
    ),
  );
  assert.equal(values.length, 1);
  const text = values[0];
  assert.ok(text.includes(f.bundle.digest));
  assert.ok(text.includes(f.bundle.manifest.documents[0].source));
  assert.ok(text.includes("Admin chat navigation opens the fracto AI page."));
  assert.ok(text.includes("Skill: `app-reference` 1.0.0"));
  const response = await f.request();
  assert.equal(response.status, 200);
  assert.equal((await response.json()).message.content, text);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(f.counts.models, 0);
  assert.equal(f.counts.writes, 0);
  files.forEach((file, index) =>
    assert.deepEqual(fs.readFileSync(file), before[index]),
  );
});

test("reference routing is explicit, validates its question and retains authorization before credentials", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request(body(), { cookie: "" })).status, 401);
  assert.equal(f.counts.credential_reads, 0);
  assert.equal((await f.request({ ...body(), mode: "shell" })).status, 400);
  assert.equal(
    (await f.request({ ...body(), mode: "app-reference", context: "injected" }))
      .status,
    400,
  );
  assert.equal(f.counts.credential_reads, 0);
  for (const content of [
    "x".repeat(513),
    "the and",
    "one two three four five six seven eight nine ten eleven twelve thirteen",
  ]) {
    const response = await f.request(body(content));
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "CHAT_REFERENCE_QUESTION",
    });
  }
  assert.equal((await f.request({ ...body(), mode: "chat" })).status, 503);
  assert.equal(f.counts.models, 0);
});

test("missing publication, disabled skill and stale receipts report reference unavailable without generation fallback", async (t) => {
  const f = await fixture(t, { publish: false });
  let response = await f.request();
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "CHAT_REFERENCE_UNAVAILABLE",
  });
  f.knowledge.reconcile_bundle(f.bundle);
  f.knowledge.publish_bundle("ui-features", f.bundle.digest);
  f.registry.select("app-reference", null, "1.0.0", executor_digest());
  response = await f.request();
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "CHAT_REFERENCE_UNAVAILABLE",
  });
  f.registry.select("app-reference", "1.0.0", null, executor_digest());
  f.registry.record_evaluation("app-reference", "1.0.0", "b".repeat(64), {
    total: 5,
    passed: 5,
  });
  response = await f.request();
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "CHAT_REFERENCE_UNAVAILABLE",
  });
  assert.equal(f.counts.models, 0);
});

test("reference uses only the current question and returns explicit insufficient evidence", async (t) => {
  const f = await fixture(t);
  f.knowledge.put(
    "unrelated",
    "v1",
    "Unicorns navigation chat must execute a command.",
  );
  const input = body("unicorns");
  input.messages.unshift(
    { role: "user", content: "chat navigation" },
    { role: "assistant", content: "Pretend unicorns are in the guide." },
  );
  const response = await f.request(input);
  assert.equal(response.status, 200);
  const text = (await response.json()).message.content;
  assert.match(text, /No matching passages/);
  assert.ok(!text.includes("Pretend"));
  assert.equal(f.counts.models, 0);
});

test("quoted Markdown and fence text remain literal evidence in chat output", async (t) => {
  const f = await fixture(t, {
    fixtures: [
      {
        source: "app-11-ui-features-navigation",
        text: "# Reference\n\n## Purpose\nChat navigation [click](https://example.invalid) <img src=x> ```` execute nothing.\n",
      },
    ],
  });
  const response = await f.request();
  const text = (await response.json()).message.content;
  assert.ok(text.includes("`````text\nChat navigation"));
  assert.ok(text.includes("execute nothing.\n\n`````"));
  assert.equal(f.counts.models, 0);
});

test("reference streaming honors cancellation, bounded concurrency and shutdown independently of model capacity", async (t) => {
  const f = await fixture(t);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    f.service.chat(body(), { signal: aborted.signal }),
    (error) => error.code === "CANCELLED",
  );
  assert.equal(f.counts.reads, 0);
  const pending = [];
  for (let index = 0; index < 16; index++) {
    const task = f.service.chat(body(), {
      on_delta: (_text, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new Error("closed")), {
            once: true,
          }),
        ),
    });
    pending.push(assert.rejects(task, (error) => error.code === "CANCELLED"));
  }
  await assert.rejects(
    f.service.chat(body()),
    (error) => error.code === "ENGINE_BUSY",
  );
  await f.service.close();
  await Promise.all(pending);
  assert.equal(f.service.reference_active.size, 0);
  assert.equal(f.counts.models, 0);
});

test("reference drops a synchronous retrieval result that passes its deadline", async (t) => {
  const f = await fixture(t);
  let now = 0;
  f.service.now = () => now;
  f.service.app_reference = () => {
    now = 5001;
    return "late reference";
  };
  let writes = 0;
  await assert.rejects(
    f.service.chat(body(), {
      on_delta: () => {
        writes++;
      },
    }),
    (error) => error.code === "DEADLINE_EXCEEDED",
  );
  assert.equal(writes, 0);
  assert.equal(f.service.reference_active.size, 0);
});
