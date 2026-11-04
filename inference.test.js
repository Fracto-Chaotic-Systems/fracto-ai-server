import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import http from "node:http";
import { create_app } from "./app.js";
import { EngineError } from "./engines/errors.js";
import { LocalStore } from "./inference/storage.js";
import { InferenceService } from "./inference/service.js";
import { normalize_request } from "./inference/contracts.js";
import { create_engine_adapter } from "./engines/registry.js";

const sample = () => ({
  contract_version: 1,
  idempotency_key: randomUUID(),
  operation: "assess_performance",
  input: {
    cpu_percent: 20,
    available_memory_mib: 8000,
    queue_depth: 0,
    failure_percent: 0,
    p95_latency_ms: 100,
  },
});
const output = {
  severity: "normal",
  reason: "normal",
  recommendation: "observe",
};
const answer = () => ({
  engine: "ollama",
  engine_version: "0.40.14",
  model_digest: "a".repeat(64),
  structured: { ...output },
  text: "private raw response",
  model: "private model",
  thinking: "private chain",
  usage: { input_tokens: 40, output_tokens: 20 },
});
const adapter = () => ({
  id: "ollama",
  model: "fixture:latest",
  status: async () => ({ state: "ready" }),
  generate: async () => answer(),
});
const wait_for = async (check) => {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) assert.fail("condition timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};
const fixture = (t, configuration = {}) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "fracto-inference-test-"),
  );
  let current;
  const open = (options = {}) => {
    const store = new LocalStore(directory);
    try {
      current = new InferenceService({
        store,
        adapter: adapter(),
        free_memory: () => 16 * 1024 ** 3,
        poll_ms: 60000,
        ...configuration,
        ...options,
      });
    } catch (error) {
      store.close();
      throw error;
    }
    return current;
  };
  t.after(async () => {
    if (current && !current.closed_for_test) await current.close();
    // Only this test's freshly created, resolved temporary directory is removed.
    assert.equal(
      path.dirname(path.resolve(directory)),
      path.resolve(os.tmpdir()),
    );
    assert.ok(path.basename(directory).startsWith("fracto-inference-test-"));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    open,
    close: async () => {
      await current.close();
      current.closed_for_test = true;
    },
  };
};

test("strict numeric operation excludes identities, raw prompts, schemas and overrides", () => {
  normalize_request(sample());
  for (const patch of [
    { messages: [] },
    { schema: {} },
    { model: "other" },
    { user: "private" },
    { operation: "raw_prompt" },
    { deadline_ms: 180001 },
    { max_output_tokens: 513 },
    { idempotency_key: "private" },
  ]) {
    assert.throws(() => normalize_request({ ...sample(), ...patch }), {
      code: "INVALID_REQUEST",
    });
  }
  for (const input of [
    { ...sample().input, server_name: "private" },
    { ...sample().input, cpu_percent: "20" },
    { ...sample().input, cpu_percent: NaN },
    {},
  ]) {
    assert.throws(() => normalize_request({ ...sample(), input }), {
      code: "INVALID_REQUEST",
    });
  }
});

test("durable completion, idempotency conflict/replay, provenance and restart", async (t) => {
  const f = fixture(t);
  let service = f.open();
  const request = sample();
  const accepted = await service.submit(request);
  assert.equal(accepted.job.state, "queued");
  assert.equal(
    (await service.submit(request)).job.request_id,
    accepted.job.request_id,
  );
  await assert.rejects(
    service.submit({
      ...request,
      input: { ...request.input, cpu_percent: 90 },
    }),
    { code: "IDEMPOTENCY_CONFLICT" },
  );
  service.tick();
  await wait_for(() => !service.active);
  assert.equal(service.inspect(accepted.job.request_id).state, "completed");
  const result = service.inspect(accepted.job.request_id, true);
  assert.deepEqual(result.output, output);
  assert.equal(result.provenance.model_digest, "a".repeat(64));
  assert.doesNotMatch(
    JSON.stringify(result),
    /private|thinking|model":|text":/,
  );
  await f.close();
  service = f.open({
    adapter: {
      ...adapter(),
      status: async () => ({ state: "engine_unavailable" }),
    },
  });
  assert.deepEqual(service.inspect(accepted.job.request_id, true), result);
  assert.equal((await service.submit(request)).replayed, true);
});

test("single concurrency, bounded pending queue and simultaneous duplicate admission", async (t) => {
  let release;
  const engine = {
    ...adapter(),
    generate: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  };
  const f = fixture(t, { adapter: engine, pending_limit: 2 });
  const service = f.open();
  const request = sample();
  const duplicate = await Promise.all([
    service.submit(request),
    service.submit(request),
  ]);
  assert.equal(duplicate[0].job.request_id, duplicate[1].job.request_id);
  service.tick();
  assert.equal(service.status().running, 1);
  await service.submit(sample());
  await service.submit(sample());
  await assert.rejects(service.submit(sample()), {
    code: "QUEUE_FULL",
    status: 429,
  });
  service.tick();
  assert.equal(service.status().queued, 2);
  release(answer());
  await wait_for(() => !service.active);
});

test("queued and running cancellation persists before a late success", async (t) => {
  let release;
  let signal;
  const engine = {
    ...adapter(),
    generate: (options) => {
      signal = options.signal;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  };
  const service = fixture(t, { adapter: engine }).open();
  const queued = (await service.submit(sample())).job.request_id;
  assert.equal(service.cancel(queued).state, "cancelled");
  const running = (await service.submit(sample())).job.request_id;
  service.tick();
  assert.equal(service.cancel(running).state, "cancelling");
  assert.equal(service.store.get(running).state, "cancelling");
  assert.ok(signal.aborted);
  release(answer());
  await wait_for(() => !service.active);
  assert.equal(service.inspect(running).state, "cancelled");
  assert.throws(() => service.inspect(running, true), {
    code: "RESULT_NOT_READY",
  });
});

test("queue and execution share a deadline; expired work never publishes a result", async (t) => {
  let now = Date.now();
  let release;
  const service = fixture(t, {
    now: () => now,
    adapter: {
      ...adapter(),
      generate: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    },
  }).open();
  const expired = (await service.submit({ ...sample(), deadline_ms: 100 })).job
    .request_id;
  now += 101;
  service.tick();
  assert.equal(service.inspect(expired).state, "expired");
  const running = (await service.submit({ ...sample(), deadline_ms: 100 })).job
    .request_id;
  service.tick();
  now += 101;
  release(answer());
  await wait_for(() => !service.active);
  assert.equal(service.inspect(running).state, "expired");
});

test("memory/disk admission, dispatch pause and engine absence are explicit", async (t) => {
  let memory = 0;
  const service = fixture(t, { free_memory: () => memory }).open();
  await assert.rejects(service.submit(sample()), { code: "MEMORY_PRESSURE" });
  memory = 16 * 1024 ** 3;
  const free_disk = service.store.free_bytes.bind(service.store);
  service.store.free_bytes = () => 0;
  await assert.rejects(service.submit(sample()), { code: "DISK_PRESSURE" });
  service.store.free_bytes = free_disk;
  const id = (await service.submit(sample())).job.request_id;
  memory = 0;
  service.tick();
  assert.equal(service.inspect(id).state, "queued");
  service.adapter.status = async () => ({ state: "model_missing" });
  memory = 16 * 1024 ** 3;
  await assert.rejects(service.submit(sample()), { code: "MODEL_MISSING" });
});

test("invalid outputs and normalized engine errors are durable, never raw provider text", async (t) => {
  const service = fixture(t).open();
  for (const generate of [
    async () => ({ ...answer(), structured: { ...output, private: "secret" } }),
    async () => {
      throw new EngineError("DEADLINE_EXCEEDED");
    },
  ]) {
    service.adapter.generate = generate;
    const id = (await service.submit(sample())).job.request_id;
    service.tick();
    await wait_for(() => !service.active);
    assert.ok(["failed", "expired"].includes(service.inspect(id).state));
    assert.equal(service.store.get(id).result_hash, null);
    assert.doesNotMatch(JSON.stringify(service.inspect(id)), /secret/);
  }
});

test("exclusive SQLite ownership, process interruption recovery and queued resume", async (t) => {
  const f = fixture(t);
  let service = f.open();
  const id = (await service.submit(sample())).job.request_id;
  const queued = (await service.submit(sample())).job.request_id;
  assert.throws(() => new LocalStore(f.directory));
  await f.close();
  const source = `import {LocalStore} from ${JSON.stringify(new URL("./inference/storage.js", import.meta.url).href)};
    const s=new LocalStore(process.argv[1]); const j=s.get(process.argv[2]); j.state='running'; j.attempt_count=1; s.save(j); process.exit(0);`;
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", source, f.directory, id],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(child.status, 0, child.stderr);
  service = f.open();
  assert.equal(service.inspect(id).state, "interrupted");
  assert.equal(service.inspect(id).attempt_count, 1);
  assert.equal(service.inspect(queued).state, "queued");
  service.tick();
  await wait_for(() => !service.active);
  assert.equal(service.inspect(queued).state, "completed");
});

test("shutdown interrupts active work and changed engine configuration never replays queued work", async (t) => {
  const engine = {
    ...adapter(),
    generate: ({ signal }) =>
      new Promise((resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new EngineError("CANCELLED")),
          { once: true },
        );
      }),
  };
  const f = fixture(t, { adapter: engine });
  let service = f.open();
  const active = (await service.submit(sample())).job.request_id;
  const queued = (await service.submit(sample())).job.request_id;
  service.tick();
  await f.close();
  service = f.open({ adapter: { ...adapter(), model: "changed:latest" } });
  assert.equal(service.inspect(active).state, "interrupted");
  assert.equal(service.inspect(queued).error, "CONFIGURATION_CHANGED");
  assert.equal(service.inspect(queued).attempt_count, 0);
});

test("retention prunes only terminal records and unreferenced owned artifacts", async (t) => {
  const service = fixture(t).open();
  const id = (await service.submit(sample())).job.request_id;
  service.tick();
  await wait_for(() => !service.active);
  const queued = (await service.submit(sample())).job.request_id;
  fs.writeFileSync(
    path.join(service.store.artifacts, "unrelated.keep"),
    "preserve",
  );
  const orphan = service.store.artifact({ orphan: true });
  service.store.retention_ms = 1;
  service.store.maintain(Date.now() + 100);
  assert.equal(service.store.get(id), null);
  assert.ok(service.store.get(queued));
  assert.ok(
    !fs.existsSync(path.join(service.store.artifacts, `${orphan}.json`)),
  );
  assert.ok(
    fs.existsSync(path.join(service.store.artifacts, "unrelated.keep")),
  );
});

test("artifact integrity and write failure disable inference without false completion", async (t) => {
  const f = fixture(t);
  let service = f.open();
  const id = (await service.submit(sample())).job.request_id;
  const original = service.store.artifact.bind(service.store);
  service.store.artifact = () => {
    throw new Error("private disk details");
  };
  service.tick();
  await wait_for(() => !service.active);
  assert.equal(service.broken, true);
  assert.equal(service.store.get(id).state, "running");
  assert.throws(() => service.inspect(id), { code: "INFERENCE_UNAVAILABLE" });
  service.store.artifact = original;
  await f.close();
  service = f.open();
  assert.equal(service.inspect(id).state, "interrupted");
  fs.writeFileSync(
    path.join(
      service.store.artifacts,
      `${service.store.get(id).input_hash}.json`,
    ),
    "corrupt",
  );
  await f.close();
  assert.throws(() => f.open());
});

test("HTTP requires separate machine auth, bounds bodies, exposes allowlisted lifecycle", async (t) => {
  const service = fixture(t).open();
  const server = create_app({ inference: service }).listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = {
    "content-type": "application/json",
    "x-fracto-ai-token": service.store.token,
  };
  for (const rejected of [
    {},
    { ...headers, "x-fracto-ai-token": "0".repeat(64) },
    { ...headers, origin: "http://browser.invalid" },
    { ...headers, cookie: "session=private" },
  ]) {
    const response = await fetch(`${base}/inference/jobs`, {
      method: "POST",
      headers: rejected,
      body: "malformed private body",
    });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "UNAUTHORIZED" });
  }
  const post = (body) =>
    fetch(`${base}/inference/jobs`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  assert.equal(
    (await post({ ...sample(), input: { private: "identity" } })).status,
    400,
  );
  assert.equal((await post({ text: "x".repeat(5000) })).status, 413);
  const response = await post(sample());
  assert.equal(response.status, 202);
  const job = await response.json();
  assert.doesNotMatch(JSON.stringify(job), /token|idempotency|input|private/);
  assert.equal(
    (
      await fetch(`${base}/inference/jobs/${job.request_id}/result`, {
        headers,
      })
    ).status,
    409,
  );
  service.tick();
  await wait_for(() => !service.active);
  const result = await (
    await fetch(`${base}/inference/jobs/${job.request_id}/result`, { headers })
  ).json();
  assert.deepEqual(result.output, output);
  assert.equal(
    (await fetch(`${base}/inference/status?private=identity`, { headers }))
      .status,
    400,
  );
  const stored = service.store.get(job.request_id);
  fs.writeFileSync(
    path.join(service.store.artifacts, `${stored.result_hash}.json`),
    "corrupt",
  );
  const corrupted = await fetch(
    `${base}/inference/jobs/${job.request_id}/result`,
    { headers },
  );
  assert.equal(corrupted.status, 503);
  assert.deepEqual(await corrupted.json(), { error: "STORAGE_UNAVAILABLE" });
  assert.equal(service.broken, true);
  assert.equal(
    (await fetch(`${base}/inference/status`, { headers })).status,
    503,
  );
  assert.equal((await fetch(`${base}/readyz`)).status, 200);
});

test("real adapter pipeline enforces the owned template, schema, thread and token budgets", async (t) => {
  const calls = [];
  const engine = http
    .createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
      calls.push({ route: req.url, body });
      const values = {
        "/api/version": { version: "0.40.14" },
        "/api/tags": {
          models: [
            { name: "fixture:latest", digest: "a".repeat(64), size: 1000 },
          ],
        },
        "/api/ps": { models: [] },
        "/api/show": { capabilities: ["completion"] },
        "/api/chat": {
          model: "fixture:latest",
          done: true,
          done_reason: "stop",
          message: { role: "assistant", content: JSON.stringify(output) },
        },
      };
      res.writeHead(values[req.url] ? 200 : 404, {
        "Content-Type": "application/json",
      });
      res.end(JSON.stringify(values[req.url] || { error: "unknown" }));
    })
    .listen(0, "127.0.0.1");
  await once(engine, "listening");
  t.after(() => new Promise((resolve) => engine.close(resolve)));
  const selected = create_engine_adapter({
    model: "fixture",
    base_url: `http://127.0.0.1:${engine.address().port}`,
  });
  const service = fixture(t, { adapter: selected }).open();
  const id = (await service.submit(sample())).job.request_id;
  service.tick();
  await wait_for(() => !service.active);
  assert.deepEqual(service.inspect(id, true).output, output);
  const chat = calls.find((call) => call.route === "/api/chat").body;
  assert.equal(chat.options.num_thread, 2);
  assert.equal(chat.options.num_predict, 256);
  assert.equal(chat.options.num_ctx, 4096);
  assert.equal(chat.format.additionalProperties, false);
  assert.equal(chat.messages.length, 2);
  assert.deepEqual(JSON.parse(chat.messages[1].content), sample().input);
  assert.ok(!calls.some((call) => /pull|generate/.test(call.route)));
});
