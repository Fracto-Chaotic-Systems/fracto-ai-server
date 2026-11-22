import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { once } from "node:events";
import { read_chat_stream, read_json_lines } from "@fracto/sdk/FractoChatStream.js";
import { stream_chat } from "@fracto/sdk/chat/ChatClient.js";
import { create_app } from "../app.js";
import { InferenceService } from "../inference/service.js";
import { launch_service_fixture } from "@fracto/sdk/testing/ServiceFixture.js";
import {fileURLToPath}from"node:url";
import { EngineError } from "../engines/errors.js";
import { EventEmitter } from "node:events";
import { write_chat_record } from "@fracto/sdk/utils/ChatStream.js";

const delta = (text) => ({ contract_version: 1, type: "delta", text });
const done = { contract_version: 1, type: "done" };
const encode = (records) =>
  records.map((record) => JSON.stringify(record) + "\n").join("");
const collect = async (iterator) => {
  const values = [];
  for await (const value of iterator) values.push(value);
  return values;
};
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { resolve, promise };
};

test("shared stream reader handles fragmented UTF-8, multiple records and final lines", async () => {
  const bytes = new TextEncoder().encode(
    encode([delta("hé🙂"), delta("llo"), done]).trimEnd(),
  );
  const body = new ReadableStream({
    start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    },
  });
  assert.deepEqual(await collect(read_chat_stream(body)), [
    delta("hé🙂"),
    delta("llo"),
    done,
  ]);
});

test("shared stream reader rejects missing completion, invalid UTF-8, trailing events and size floods", async () => {
  for (const content of [
    encode([delta("partial")]),
    encode([done]),
    encode([delta("x"), done, delta("late")]),
    encode([
      delta("x"),
      { contract_version: 1, type: "error", error: "private" },
    ]),
    "{bad}\n",
    encode([delta("x".repeat(65537)), done]),
    new Uint8Array([255]),
  ]) {
    await assert.rejects(collect(read_chat_stream(new Response(content).body)));
  }
  await assert.rejects(
    collect(
      read_json_lines(new Response("x".repeat(300)).body, { max_bytes: 100 }),
    ),
  );
  await assert.rejects(
    collect(read_json_lines(new Response("{}\n{}\n").body, { max_records: 1 })),
  );
  await assert.rejects(
    collect(
      read_chat_stream(
        new Response(
          encode([
            delta("partial"),
            { contract_version: 1, type: "error", error: "CHAT_TIMEOUT" },
          ]),
        ).body,
      ),
    ),
    /CHAT_TIMEOUT/,
  );
});

test("browser stream adapter yields cumulative text and sends credentials only to admin", async () => {
  let request;
  const response = new Response(encode([delta("One"), delta(" two"), done]), {
    headers: { "Content-Type": "application/x-ndjson" },
  });
  const values = await collect(
    stream_chat(
      "/api/admin/chat",
      [{ role: "user", content: "Hello" }],
      undefined,
      async (_url, options) => {
        request = options;
        return response;
      },
    ),
  );
  assert.deepEqual(values, ["One", "One two"]);
  assert.equal(request.credentials, "include");
  assert.equal(request.headers.Accept, "application/x-ndjson");
  assert.equal(request.headers["X-Fracto-AI-Token"], undefined);
});

test("browser stream adapter distinguishes login failures from generation failures", async () => {
  for (const [status, code] of [
    [401, "CHAT_AUTH_REQUIRED"],
    [403, "CHAT_FORBIDDEN"],
    [429, "CHAT_BUSY"],
    [504, "CHAT_TIMEOUT"],
  ]) {
    await assert.rejects(
      collect(
        stream_chat(
          "/chat",
          [],
          undefined,
          async () => new Response("private", { status }),
        ),
      ),
      new RegExp(code),
    );
  }
});

test("browser stream adapter preserves fixed reference availability and question errors", async () => {
  for (const [status, error] of [
    [503, "CHAT_REFERENCE_UNAVAILABLE"],
    [400, "CHAT_REFERENCE_QUESTION"],
  ]) {
    await assert.rejects(
      collect(
        stream_chat(
          "/chat",
          [],
          undefined,
          async () => Response.json({ error }, { status }),
          "app-reference",
        ),
      ),
      new RegExp(error),
    );
  }
});

test("browser stream adapter preserves allowlisted memory errors", async () => {
  await assert.rejects(
    collect(
      stream_chat("/chat", [], undefined, async () =>
        Response.json({ error: "CHAT_MEMORY_PRESSURE" }, { status: 503 }),
      ),
    ),
    /CHAT_MEMORY_PRESSURE/,
  );
  await assert.rejects(
    collect(
      stream_chat("/chat", [], undefined, async () =>
        Response.json({ error: "private diagnostic" }, { status: 503 }),
      ),
    ),
    /CHAT_UNAVAILABLE/,
  );
});

test("stream writes wait for downstream backpressure and abort cleanly", async () => {
  const res = Object.assign(new EventEmitter(), {
    headersSent: false,
    destroyed: false,
    writableEnded: false,
    setHeader() {},
    write() {
      return false;
    },
  });
  let finished = false;
  const pending = write_chat_record(res, delta("test")).then(() => {
    finished = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  res.emit("drain");
  await pending;
  assert.equal(finished, true);
  const controller = new AbortController();
  const blocked = write_chat_record(res, delta("test"), controller.signal);
  const rejected = assert.rejects(blocked, /Stream closed/);
  controller.abort();
  await rejected;
  assert.equal(res.listenerCount("drain"), 0);
  assert.equal(res.listenerCount("close"), 0);
});

const bridge = async (t, stream, options = {}) => {
  const token = "a".repeat(64);
  const service = new InferenceService({
    store: {
      token,
      all: () => [],
      maintain() {},
      close() {},
      free_bytes: () => 10 * 1024 ** 3,
    },
    adapter: { stream },
    free_memory: () => 16 * 1024 ** 3,
    poll_ms: 60000,
  });
  const ai = create_app({ inference: service }).listen(0, "127.0.0.1");
  await once(ai, "listening");
  const admin=await launch_service_fixture(fileURLToPath(new URL("../../fracto-admin-server/test/chat_fixture.mjs",import.meta.url)),{port:ai.address().port,token,...options},t);
  t.after(async () => {
    await service.close();
    await admin.close();
    ai.closeAllConnections();
    await Promise.all([

      new Promise((r) => ai.close(r)),
    ]);
  });
  return { url: admin.base+"/chat", service };
};

test(
  "both HTTP hops deliver the first delta before model completion and filter metadata",
  { timeout: 5000 },
  async (t) => {
    const finish = deferred();
    t.after(() => finish.resolve());
    const { url } = await bridge(t, async (_request, { on_delta }) => {
      await on_delta("First ");
      await finish.promise;
      await on_delta("second");
      return { text: "First second", model: "private", thinking: "private" };
    });
    const iterator = stream_chat(url, [{ role: "user", content: "Fixture" }]);
    assert.deepEqual(await iterator.next(), { value: "First ", done: false });
    finish.resolve();
    assert.deepEqual(await iterator.next(), {
      value: "First second",
      done: false,
    });
    assert.equal((await iterator.next()).done, true);
  },
);

test("late engine failure retains partial text and fails the stream without success", async (t) => {
  const { url } = await bridge(t, async (_request, { on_delta }) => {
    await on_delta("Partial");
    throw new Error("private provider diagnostic");
  });
  const iterator = stream_chat(url, [{ role: "user", content: "Fixture" }]);
  assert.equal((await iterator.next()).value, "Partial");
  await assert.rejects(iterator.next(), /CHAT_UNAVAILABLE/);
});

test(
  "stream timeout after headers sends a terminal error and aborts the model",
  { timeout: 5000 },
  async (t) => {
    const aborted = deferred();
    const { url } = await bridge(
      t,
      async ({ signal }, { on_delta }) => {
        await on_delta("Partial");
        await new Promise((_resolve, reject) =>
          signal.addEventListener(
            "abort",
            () => {
              aborted.resolve();
              reject(new EngineError("CANCELLED"));
            },
            { once: true },
          ),
        );
      },
      { timeout_ms: 100 },
    );
    const iterator = stream_chat(url, [{ role: "user", content: "Fixture" }]);
    assert.equal((await iterator.next()).value, "Partial");
    await assert.rejects(iterator.next(), /CHAT_TIMEOUT/);
    await aborted.promise;
  },
);

test(
  "browser Stop aborts generation through both streaming hops and frees capacity",
  { timeout: 5000 },
  async (t) => {
    const aborted = deferred();
    const { url, service } = await bridge(
      t,
      async ({ signal }, { on_delta }) => {
        await on_delta("Partial");
        await new Promise((_resolve, reject) =>
          signal.addEventListener(
            "abort",
            () => {
              aborted.resolve();
              reject(new EngineError("CANCELLED"));
            },
            { once: true },
          ),
        );
      },
    );
    const controller = new AbortController();
    const iterator = stream_chat(
      url,
      [{ role: "user", content: "Fixture" }],
      controller.signal,
    );
    assert.equal((await iterator.next()).value, "Partial");
    controller.abort();
    await assert.rejects(iterator.next());
    await aborted.promise;
    // Allow cancellation propagation to finish before checking admission.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(service.chat_active, null);
  },
);
