import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { EngineError } from "./engines/errors.js";
import {
  create_engine_adapter,
  create_engine_status_reader,
} from "./engines/registry.js";

const digest = "a".repeat(64);
const schema = {
  type: "object",
  properties: { state: { type: "string", enum: ["ready"] } },
  required: ["state"],
  additionalProperties: false,
};
const request = {
  messages: [{ role: "user", content: "Report the synthetic fixture state." }],
  schema,
};
const result = () => ({
  model: "fixture:latest",
  done: true,
  done_reason: "stop",
  message: {
    role: "assistant",
    content: '{"state":"ready"}',
    thinking: "private",
    user: "private",
  },
  total_duration: 50000000,
  load_duration: 10000000,
  prompt_eval_duration: 20000000,
  eval_duration: 20000000,
  prompt_eval_count: 8,
  eval_count: 4,
  private_record: "not-for-consumers",
});

const fixture = async (t, options = {}) => {
  const calls = [];
  const server = http
    .createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length
        ? JSON.parse(Buffer.concat(chunks).toString())
        : null;
      calls.push({ path: req.url, body, headers: req.headers });
      const send = (value, status = 200) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (req.url === "/api/version")
        return send({ version: "0.40.14", user: "private" });
      if (req.url === "/api/tags")
        return send({
          models: options.missing
            ? []
            : [{ name: "fixture:latest", digest, size: 1000, user: "private" }],
        });
      if (req.url === "/api/ps") return send({ models: [] });
      if (req.url === "/api/show")
        return send({
          capabilities: ["completion", "thinking"],
          ...options.details,
        });
      if (req.url === "/api/chat") {
        if (options.chat) return options.chat({ req, res, body, send });
        return send(result());
      }
      if (req.url === "/api/generate")
        return options.warmup
          ? options.warmup({ req, res, send })
          : send({ done: true });
      return send({ error: "private engine message" }, 404);
    })
    .listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return {
    calls,
    adapter: create_engine_adapter({
      model: "fixture",
      base_url: `http://127.0.0.1:${server.address().port}`,
    }),
  };
};

test("pinned model digest rejects a changed selection before transmitting generation messages", async (t) => {
  const { adapter, calls } = await fixture(t);
  await assert.rejects(
    adapter.generate({ ...request, expected_model_digest: "b".repeat(64) }),
    { code: "MODEL_MISMATCH" },
  );
  assert.equal(calls.filter((call) => call.path === "/api/chat").length, 0);
  assert.equal(
    (await adapter.generate({ ...request, expected_model_digest: digest }))
      .model_digest,
    digest,
  );
});

test("normalizes generation, validates JSON independently, and allowlists transport and result fields", async (t) => {
  const { adapter, calls } = await fixture(t);
  assert.deepEqual(await adapter.list_models(), [
    { id: "fixture:latest", digest, size_bytes: 1000 },
  ]);
  const generated = await adapter.generate(request);
  assert.deepEqual(generated.structured, { state: "ready" });
  assert.deepEqual(generated.usage, { input_tokens: 8, output_tokens: 4 });
  assert.deepEqual(generated.timings_ms, {
    total: 50,
    load: 10,
    input: 20,
    output: 20,
  });
  assert.equal(generated.model_digest, digest);
  assert.equal(JSON.stringify(generated).includes("private"), false);
  const chat = calls.find((call) => call.path === "/api/chat");
  assert.deepEqual(chat.body.options, {
    num_ctx: 4096,
    num_thread: 2,
    num_predict: 512,
    temperature: 0,
  });
  assert.equal(chat.body.stream, false);
  assert.equal(chat.body.keep_alive, 0);
  assert.equal(chat.body.think, false);
  assert.deepEqual(chat.body.format, schema);
  assert.equal(chat.headers.cookie, undefined);
  assert.equal(chat.headers.authorization, undefined);
  assert.equal((await adapter.status()).state, "ready");
});

test("bad JSON and schema mismatches produce redacted INVALID_OUTPUT", async (t) => {
  for (const content of [
    "not JSON private",
    '{"state":"wrong","private":"secret"}',
  ]) {
    const { adapter } = await fixture(t, {
      chat: ({ send }) =>
        send({ ...result(), message: { role: "assistant", content } }),
    });
    await assert.rejects(
      adapter.generate(request),
      (error) =>
        error.code === "INVALID_OUTPUT" && !error.message.includes("private"),
    );
  }
});

test("missing model and remote-model descriptors never transmit prompts or pull a model", async (t) => {
  for (const options of [
    { missing: true },
    { details: { remote_host: "private-remote" } },
  ]) {
    const { adapter, calls } = await fixture(t, options);
    await assert.rejects(adapter.generate(request), (error) =>
      ["MODEL_MISSING", "UNSUPPORTED_OPERATION"].includes(error.code),
    );
    assert.equal(
      calls.some((call) =>
        ["/api/chat", "/api/pull", "/api/generate"].includes(call.path),
      ),
      false,
    );
  }
});

test("one request at a time; cancellation aborts transport and releases the adapter slot", async (t) => {
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const { adapter } = await fixture(t, { chat: () => entered() });
  const controller = new AbortController();
  const pending = adapter.generate({ ...request, signal: controller.signal });
  const rejected = assert.rejects(
    pending,
    (error) => error.code === "CANCELLED" && !error.message.includes("private"),
  );
  await started;
  assert.equal((await adapter.status()).state, "busy");
  await assert.rejects(
    adapter.generate(request),
    (error) => error.code === "ENGINE_BUSY",
  );
  controller.abort("private abort reason");
  await rejected;
  assert.equal(adapter.phase, null);
});

test("a deadline covers a stalled response body, not only HTTP headers", async (t) => {
  let body_opened = false;
  const { adapter } = await fixture(t, {
    chat: ({ res }) => {
      body_opened = true;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"message":');
    },
  });
  await assert.rejects(
    adapter.generate({ ...request, timeout_ms: 500 }),
    (error) => error.code === "DEADLINE_EXCEEDED",
  );
  assert.equal(body_opened, true);
  assert.equal(adapter.phase, null);
});

test("unsupported fields, schema features, URLs and providers fail explicitly", async (t) => {
  const { adapter, calls } = await fixture(t);
  for (const bad of [
    { ...request, stream: true },
    { ...request, base_url: "http://private" },
    { ...request, schema: { type: "string", pattern: ".*" } },
    { ...request, schema: { $ref: "http://private/schema" } },
    { ...request, schema: { type: "object", unsupported: undefined } },
    { ...request, max_tokens: 999999 },
    {
      ...request,
      messages: [{ role: "user", content: "fixture", user: "private" }],
    },
  ]) {
    await assert.rejects(adapter.generate(bad), (error) =>
      ["UNSUPPORTED_OPERATION", "INVALID_REQUEST"].includes(error.code),
    );
  }
  assert.equal(calls.length, 0);
  await assert.rejects(
    adapter.embed(),
    (error) => error.code === "UNSUPPORTED_OPERATION",
  );
  await assert.rejects(
    adapter.stream(),
    (error) => error.code === "UNSUPPORTED_OPERATION",
  );
  for (const engine of ["llama_cpp", "vllm", "sglang"]) {
    const reserved = create_engine_adapter({ engine });
    assert.equal((await reserved.status()).state, "adapter_unavailable");
    await assert.rejects(
      reserved.generate(request),
      (error) => error.code === "NOT_IMPLEMENTED",
    );
  }
  for (const base_url of [
    "https://127.0.0.1:11434",
    "http://remote:11434",
    "http://private@localhost:11434",
    "http://localhost:11434/api",
  ]) {
    assert.throws(
      () => create_engine_adapter({ base_url }),
      (error) => error.code === "CONFIGURATION_ERROR",
    );
  }
  assert.throws(
    () =>
      create_engine_adapter({ base_url: "http://host.docker.internal:11434" }),
    (error) => error.code === "CONFIGURATION_ERROR",
  );
  assert.doesNotThrow(() =>
    create_engine_adapter({
      base_url: "http://host.docker.internal:11434",
      allow_host_gateway: true,
    }),
  );
});

test("warm-up is explicit, has a distinct phase, and is never started by status", async (t) => {
  let release;
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const { adapter, calls } = await fixture(t, {
    warmup: ({ send }) => {
      release = () => send({ done: true });
      entered();
    },
  });
  await adapter.status();
  assert.equal(
    calls.some((call) => call.path === "/api/generate"),
    false,
  );
  const pending = adapter.warmup();
  await started;
  assert.equal((await adapter.status()).state, "warming");
  release();
  assert.equal((await pending).loaded, true);
});

test("provider errors and redirects never leak bodies or follow new destinations", async (t) => {
  for (const status of [404, 503, 500, 302]) {
    const { adapter } = await fixture(t, {
      chat: ({ res, send }) => {
        if (status === 302) res.setHeader("Location", "http://private/secret");
        send({ error: "private identity and filesystem details" }, status);
      },
    });
    await assert.rejects(
      adapter.generate(request),
      (error) =>
        error instanceof EngineError &&
        !JSON.stringify(error).includes("private"),
    );
  }
  const unavailable = create_engine_adapter({
    fetch_impl: async () => {
      throw new Error("private network details");
    },
  });
  assert.equal((await unavailable.status()).state, "engine_unavailable");
  assert.equal(
    JSON.stringify(await unavailable.status()).includes("private"),
    false,
  );
  const invalid = create_engine_status_reader({
    FRACTO_AI_ENGINE: "private input",
  });
  assert.equal((await invalid()).state, "configuration_error");
});

test("status probes coalesce and cache; model absence never generates work", async (t) => {
  const { adapter, calls } = await fixture(t, { missing: true });
  let clock = 10000;
  adapter.now = () => clock;
  const statuses = await Promise.all(
    Array.from({ length: 10 }, () => adapter.status()),
  );
  assert.equal(calls.length, 3);
  assert.ok(statuses.every((item) => item.state === "model_missing"));
  await adapter.status();
  assert.equal(calls.length, 3);
  clock += 5001;
  await adapter.status();
  assert.equal(calls.length, 6);
  assert.equal(
    calls.some(
      (item) => item.path === "/api/chat" || item.path === "/api/generate",
    ),
    false,
  );
});

test("oversized responses, wrong model results and malformed metadata fail closed", async (t) => {
  for (const chat of [
    ({ send }) => send({ ...result(), model: "another:latest" }),
    ({ send }) =>
      send({
        ...result(),
        message: { role: "assistant", content: "x".repeat(65537) },
      }),
    ({ send }) => send({ ...result(), private: "x".repeat(2 * 1024 * 1024) }),
  ]) {
    const { adapter } = await fixture(t, { chat });
    await assert.rejects(
      adapter.generate(request),
      (error) => error.code === "PROTOCOL_ERROR",
    );
  }
  const invalid = create_engine_adapter({
    fetch_impl: async () =>
      new Response(JSON.stringify({ version: "private-version" }), {
        headers: { "Content-Type": "application/json" },
      }),
  });
  await assert.rejects(
    invalid.health(),
    (error) =>
      error.code === "PROTOCOL_ERROR" && !error.message.includes("private"),
  );
});
