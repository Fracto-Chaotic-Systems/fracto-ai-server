import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { create_app } from "./app.js";
import { InferenceService } from "./inference/service.js";
import { EngineError } from "./engines/errors.js";
import { chat_messages } from "./inference/chat.js";

const token = "a".repeat(64);
const sample = () => ({
  contract_version: 1,
  messages: [{ role: "user", content: "Hello" }],
});
const fixture = async (t, options = {}) => {
  const jobs = [];
  const calls = [];
  let writes = 0;
  const service = new InferenceService({
    store: {
      token,
      all: () => jobs,
      maintain() {},
      close() {},
      free_bytes: () => 10 * 1024 ** 3,
      artifact() {
        writes++;
      },
      insert() {
        writes++;
      },
      save() {
        writes++;
      },
    },
    adapter: {
      generate: async (request) => {
        calls.push(request);
        return { text: "Hello back", thinking: "private", model: "private" };
      },
    },
    free_memory: () => 16 * 1024 ** 3,
    poll_ms: 60000,
    ...options,
  });
  const server = create_app({ inference: service }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await service.close();
    await new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    service,
    jobs,
    calls,
    base,
    get writes() {
      return writes;
    },
    request: (body = sample(), headers = {}, suffix = "") =>
      fetch(`${base}/inference/chat${suffix}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Fracto-AI-Token": token,
          ...headers,
        },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
  };
};

test("chat generates text with bounded settings and does not persist conversation data", async (t) => {
  const f = await fixture(t);
  const body = sample();
  body.messages.unshift(
    { role: "user", content: "First question" },
    { role: "assistant", content: "First answer" },
  );
  const response = await f.request(body);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    contract_version: 1,
    message: { role: "assistant", content: "Hello back" },
  });
  assert.deepEqual(f.calls[0].messages, body.messages);
  assert.equal(f.calls[0].max_tokens, 512);
  assert.equal(f.calls[0].timeout_ms, 175000);
  assert.ok(f.calls[0].signal instanceof AbortSignal);
  assert.equal(f.writes, 0);
  assert.equal(f.service.chat_active, null);
});

test("chat enforces machine authentication and rejects browser headers", async (t) => {
  const f = await fixture(t);
  for (const headers of [
    { "X-Fracto-AI-Token": "" },
    { "X-Fracto-AI-Token": "b".repeat(64) },
    { cookie: "session=admin" },
    { origin: "http://localhost:3006" },
  ]) {
    assert.equal((await f.request("not json", headers)).status, 401);
  }
  assert.equal(f.calls.length, 0);
});

test("chat validates history independently of the administrator bridge", async (t) => {
  const f = await fixture(t);
  for (const body of [
    {},
    { ...sample(), model: "other" },
    { ...sample(), contract_version: 2 },
    { ...sample(), messages: [] },
    { ...sample(), messages: Array(17).fill(sample().messages[0]) },
    ...["system", "tool", "assistant"].map((role) => ({
      ...sample(),
      messages: [{ role, content: "x" }],
    })),
    { ...sample(), messages: [{ role: "user", content: " " }] },
    { ...sample(), messages: [{ role: "user", content: "x", file: "bad" }] },
    { ...sample(), messages: [{ role: "user", content: "é".repeat(4096) }] },
  ]) {
    assert.throws(() => chat_messages(body));
    assert.equal((await f.request(body)).status, 400);
  }
  assert.equal((await f.request(sample(), {}, "?model=other")).status, 400);
  assert.equal((await f.request("x".repeat(17 * 1024))).status, 413);
  assert.equal(f.calls.length, 0);
});

test("chat accepts its larger bounded body without changing the job body limit", async (t) => {
  const f = await fixture(t);
  const body = {
    ...sample(),
    messages: [{ role: "user", content: "x".repeat(5000) }],
  };
  assert.equal((await f.request(body)).status, 200);
  const response = await fetch(`${f.base}/inference/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Fracto-AI-Token": token },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 413);
});

test("chat respects memory and storage pressure", async (t) => {
  const f = await fixture(t, { free_memory: () => 0 });
  assert.equal((await f.request()).status, 503);
  assert.equal(f.calls.length, 0);
});

test("chat shares capacity with chat and queued inference, and cancels on shutdown", async (t) => {
  let started;
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  const f = await fixture(t, {
    adapter: {
      generate: async ({ signal }) =>
        new Promise((_resolve, reject) => {
          started();
          signal.addEventListener(
            "abort",
            () => reject(new EngineError("CANCELLED")),
            { once: true },
          );
        }),
    },
  });
  const pending = f.service.chat(sample());
  const rejected = assert.rejects(
    pending,
    (error) => error.code === "CANCELLED",
  );
  await entered;
  assert.equal(f.service.status().running, 1);
  assert.equal((await f.request()).status, 429);
  f.jobs.push({
    id: "queued",
    state: "queued",
    deadline_at: Date.now() + 10000,
  });
  f.service.tick();
  assert.equal(f.service.active, null);
  await f.service.close();
  await rejected;
  assert.equal(f.service.chat_active, null);
});

test("queued jobs and active jobs have priority over new chats", async (t) => {
  const f = await fixture(t);
  f.jobs.push({ state: "queued" });
  assert.equal((await f.request()).status, 429);
  f.jobs.pop();
  f.service.active = { controller: new AbortController() };
  assert.equal((await f.request()).status, 429);
  f.service.active = null;
  assert.equal(f.calls.length, 0);
});

test("chat rejects invalid outputs and does not expose provider failure details", async (t) => {
  for (const generate of [
    async () => ({ text: " " }),
    async () => ({ text: "x".repeat(65537) }),
    async () => {
      throw new Error("private provider error");
    },
    async () => {
      throw new EngineError("MODEL_MISSING");
    },
  ]) {
    const f = await fixture(t, { adapter: { generate } });
    const response = await f.request();
    assert.equal(response.status, 503);
    assert.ok(!(await response.text()).includes("private"));
    assert.equal(f.service.chat_active, null);
    assert.equal(f.writes, 0);
  }
});

test("cancelled chat drops late output and releases capacity", async (t) => {
  let finish;
  const f = await fixture(t, {
    adapter: {
      generate: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    },
  });
  const controller = new AbortController();
  const pending = f.service.chat(sample(), { signal: controller.signal });
  const rejected = assert.rejects(
    pending,
    (error) => error.code === "CANCELLED",
  );
  controller.abort();
  finish({ text: "late response" });
  await rejected;
  assert.equal(f.service.chat_active, null);
});
