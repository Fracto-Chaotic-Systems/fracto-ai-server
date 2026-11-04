import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { create_app } from "./app.js";
import { LocalStore } from "./inference/storage.js";
import { InferenceService } from "./inference/service.js";
import { EngineError } from "./engines/errors.js";
import { generate_identity } from "./peers/identity.js";
import { validate_trust } from "./peers/configuration.js";
import { create_peer_server } from "./peers/server.js";
import { peer_request } from "./peers/client.js";
import { PeerError } from "./peers/files.js";
import { DelegationRuntime } from "./delegation/runtime.js";
import { DelegationReceiver } from "./delegation/receiver.js";
import { local_request, wire_request } from "./delegation/contracts.js";

const [a, b, c] = await Promise.all([
  generate_identity(),
  generate_identity(),
  generate_identity(),
]);
const digest = "a".repeat(64);
const facts = () => ({
  cpu_percent: 20,
  available_memory_mib: 8000,
  queue_depth: 0,
  failure_percent: 0,
  p95_latency_ms: 100,
});
const expected = () => ({
  engine: "ollama",
  model_digest: digest,
  profile_version: 1,
});
const request = () => ({
  contract_version: 1,
  idempotency_key: randomUUID(),
  peer_id: b.node_id,
  expected: expected(),
  operation: "assess_performance",
  input: facts(),
});
const wire = (patch = {}) => {
  const now = Date.now();
  return {
    contract_version: 1,
    origin_node_id: a.node_id,
    origin_request_id: randomUUID(),
    origin_idempotency_key: randomUUID(),
    hop_count: 1,
    created_at: now,
    deadline_at: now + 180000,
    remaining_ms: 180000,
    expected: expected(),
    request: {
      operation: "assess_performance",
      input: facts(),
      max_output_tokens: 256,
    },
    ...patch,
  };
};
const temp = (t, dispose = () => {}) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "fracto-delegation-test-"),
  );
  t.after(async () => {
    await dispose();
    assert.equal(
      path.dirname(path.resolve(directory)),
      path.resolve(os.tmpdir()),
    );
    assert.ok(path.basename(directory).startsWith("fracto-delegation-test-"));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
};
const source = (t, options = {}) => {
  let service;
  const directory = temp(t, () => service?.close());
  const state = { digest, calls: 0 };
  const adapter = {
    id: "ollama",
    model: "private-model:latest",
    status: async () => ({ state: "ready" }),
    list_models: async () => [
      { id: "private-model:latest", digest: state.digest, size_bytes: 1000 },
    ],
    generate: async (input) => {
      if (
        input.expected_model_digest &&
        input.expected_model_digest !== state.digest
      )
        throw new EngineError("MODEL_MISMATCH");
      state.calls++;
      if (options.generate) return options.generate(input);
      return {
        engine: "ollama",
        engine_version: "0.40.14",
        model_digest: state.digest,
        structured: {
          severity: "normal",
          reason: "normal",
          recommendation: "observe",
        },
        usage: { input_tokens: 40, output_tokens: 20 },
        text: "private raw output",
      };
    },
  };
  const open = () =>
    new InferenceService({
      store: new LocalStore(directory),
      adapter,
      free_memory: () => 16 * 1024 ** 3,
      poll_ms: options.poll_ms ?? 60000,
      pending_limit: options.pending_limit ?? 16,
    });
  service = open();
  return {
    get service() {
      return service;
    },
    state,
    reopen: async () => {
      await service.close();
      service = open();
      return service;
    },
  };
};
const entry = (identity, port = 3447, scopes = ["inference:delegate"]) => ({
  node_id: identity.node_id,
  certificate: identity.certificate,
  endpoint: `https://127.0.0.1:${port}`,
  inbound_scopes: scopes,
  outbound_scopes: scopes,
  revoked: false,
});
const trust = (own, list) =>
  validate_trust({ contract_version: 1, peers: list }, own.node_id);
const origin = (t, options = {}) => {
  let runtime;
  const directory = temp(t, () => runtime?.close());
  const configuration = {
    directory,
    node_id: a.node_id,
    source: () => null,
    identity: () => a,
    peers: () => trust(a, [entry(b)]),
    poll_ms: 60000,
    query_interval_ms: 0,
    min_peer_interval_ms: 0,
    ...options,
  };
  const open = () => {
    runtime = new DelegationRuntime(configuration);
    return runtime;
  };
  open();
  return {
    get value() {
      return runtime;
    },
    reopen: async () => {
      await runtime.close();
      return open();
    },
    directory,
  };
};
const step = async (runtime) => {
  runtime.tick();
  await runtime.active?.task;
};
const wait_for = async (check) => {
  const end = Date.now() + 10000;
  while (!check()) {
    if (Date.now() > end) assert.fail("condition timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};
const transport = (receiver, trace) => async (options) => {
  trace.push({
    method: options.method || "GET",
    route: options.route,
    peer: options.peer.node_id,
  });
  try {
    if (options.route === "/peer/v1/delegations")
      return await receiver.accept(a.node_id, options.body);
    if (options.route.endsWith("/capabilities"))
      return { status: 200, value: await receiver.capabilities() };
    const id = options.route.split("/")[4];
    return {
      status: 200,
      value: options.route.endsWith("/cancel")
        ? receiver.cancel(a.node_id, id)
        : receiver.inspect(a.node_id, id),
    };
  } catch (error) {
    return {
      status: error.status || 503,
      value: {
        contract_version: 1,
        error: error.code || "DELEGATION_UNAVAILABLE",
        acceptance: "rejected",
      },
    };
  }
};

test("delegation accepts only bounded aggregate requests with an explicit peer, digest and one-hop origin", () => {
  local_request(request());
  wire_request(wire(), a.node_id);
  for (const patch of [
    { peer_url: "private" },
    { messages: [] },
    { model: "private" },
    { expected: { ...expected(), model_digest: "private" } },
    { peer_id: "private" },
  ])
    assert.throws(() => local_request({ ...request(), ...patch }));
  for (const patch of [
    { hop_count: 2 },
    { origin_node_id: c.node_id },
    { forward_to: c.node_id },
    { request: { ...wire().request, messages: [] } },
  ])
    assert.throws(() => wire_request(wire(patch), a.node_id));
});

test("receiver durably deduplicates by sender/key, rejects conflicts, and isolates status by sender", async (t) => {
  const { service } = source(t);
  const receiver = new DelegationReceiver({
    node_id: b.node_id,
    source: () => service,
  });
  const body = wire();
  const receipts = await Promise.all([
    receiver.accept(a.node_id, body),
    receiver.accept(a.node_id, { ...body, remaining_ms: 179000 }),
  ]);
  assert.ok(receipts.some((receipt) => receipt.status === 202));
  assert.equal(service.store.all().length, 1);
  await assert.rejects(
    receiver.accept(a.node_id, {
      ...body,
      request: { ...body.request, input: { ...facts(), cpu_percent: 80 } },
    }),
    { code: "IDEMPOTENCY_CONFLICT" },
  );
  await assert.rejects(
    receiver.accept(a.node_id, {
      ...body,
      origin_idempotency_key: randomUUID(),
    }),
    { code: "IDEMPOTENCY_CONFLICT" },
  );
  assert.throws(() => receiver.inspect(c.node_id, body.origin_request_id), {
    code: "DELEGATION_NOT_FOUND",
  });
  assert.equal(
    receiver.inspect(a.node_id, body.origin_request_id).executor_node_id,
    b.node_id,
  );
});

test("receiver shares the bounded local queue and rejects missing headroom or a changed model", async (t) => {
  const { service, state } = source(t, { pending_limit: 1 });
  const receiver = new DelegationReceiver({
    node_id: b.node_id,
    source: () => service,
  });
  const body = wire();
  await receiver.accept(a.node_id, body);
  await assert.rejects(receiver.accept(a.node_id, wire()), {
    code: "QUEUE_FULL",
  });
  state.digest = "b".repeat(64);
  service.tick();
  await service.active?.task;
  assert.equal(state.calls, 0);
  assert.equal(
    receiver.inspect(a.node_id, body.origin_request_id).error,
    "MODEL_MISMATCH",
  );
  await assert.rejects(receiver.accept(a.node_id, wire()), {
    code: "MODEL_MISMATCH",
  });
  state.digest = digest;
  service.free_memory = () => 0;
  await assert.rejects(receiver.accept(a.node_id, wire()), {
    code: "MEMORY_PRESSURE",
  });
});

test("receiver enforces original deadlines and clock bounds without executing late results", async (t) => {
  const { service } = source(t);
  const receiver = new DelegationReceiver({
    node_id: b.node_id,
    source: () => service,
  });
  const expired = wire({
    created_at: Date.now() - 1000,
    deadline_at: Date.now() - 500,
    remaining_ms: 100,
  });
  await assert.rejects(receiver.accept(a.node_id, expired), {
    code: "DEADLINE_EXCEEDED",
  });
  await assert.rejects(
    receiver.accept(a.node_id, wire({ remaining_ms: 10000 })),
    { code: "CLOCK_SKEW" },
  );
  const body = wire();
  await receiver.accept(a.node_id, body);
  const job = service.store.all()[0];
  job.deadline_at = Date.now() - 1;
  service.store.save(job);
  service.tick();
  assert.equal(
    receiver.inspect(a.node_id, body.origin_request_id).state,
    "expired",
  );
});

test("lost acknowledgement is reconciled after origin restart without another generation POST", async (t) => {
  const { service, state } = source(t);
  const receiver = new DelegationReceiver({
    node_id: b.node_id,
    source: () => service,
  });
  const trace = [];
  const safe = transport(receiver, trace);
  let lose_ack = true;
  const fixture = origin(t, {
    request: async (options) => {
      const response = await safe(options);
      if (options.route === "/peer/v1/delegations" && lose_ack) {
        lose_ack = false;
        throw new PeerError("PEER_DEADLINE_EXCEEDED");
      }
      return response;
    },
  });
  const body = request();
  const receipt = fixture.value.submit(body);
  await step(fixture.value);
  assert.equal(fixture.value.inspect(receipt.request_id).state, "unknown");
  assert.equal(service.store.all().length, 1);
  await fixture.reopen();
  assert.equal(fixture.value.submit(body).replayed, true);
  const row = fixture.value.store.get(receipt.request_id);
  row.next_at = 0;
  fixture.value.store.save(row);
  await step(fixture.value);
  assert.equal(fixture.value.inspect(receipt.request_id).state, "accepted");
  service.tick();
  await service.active?.task;
  await step(fixture.value);
  assert.equal(fixture.value.inspect(receipt.request_id).state, "completed");
  assert.equal(
    fixture.value.inspect(receipt.request_id, true).executor_node_id,
    b.node_id,
  );
  assert.equal(state.calls, 1);
  assert.equal(
    trace.filter((item) => item.route === "/peer/v1/delegations").length,
    1,
  );
});

test("ambiguous offline submission never fans out or retries; missing remote history stays unknown", async (t) => {
  const trace = [];
  const fixture = origin(t, {
    peers: () => trust(a, [entry(b), entry(c)]),
    request: async (options) => {
      trace.push(options);
      if (options.method === "POST") throw new PeerError("PEER_UNAVAILABLE");
      return {
        status: 404,
        value: { contract_version: 1, error: "DELEGATION_NOT_FOUND" },
      };
    },
  });
  const receipt = fixture.value.submit(request());
  await step(fixture.value);
  await step(fixture.value);
  await step(fixture.value);
  assert.equal(trace.filter((item) => item.method === "POST").length, 1);
  assert.ok(trace.every((item) => item.peer.node_id === b.node_id));
  assert.equal(fixture.value.inspect(receipt.request_id).state, "unknown");
  const row = fixture.value.store.get(receipt.request_id);
  row.deadline_at = Date.now() - 300001;
  fixture.value.store.save(row);
  await step(fixture.value);
  assert.equal(fixture.value.inspect(receipt.request_id).reconciling, false);
  assert.equal(
    fixture.value.inspect(receipt.request_id).error,
    "RECONCILIATION_EXPIRED",
  );
});

test("confirmed rejection is final; outgoing capacity and prepared cancellation are bounded", async (t) => {
  let posts = 0;
  const fixture = origin(t, {
    request: async () => {
      posts++;
      return {
        status: 429,
        value: {
          contract_version: 1,
          acceptance: "rejected",
          error: "QUEUE_FULL",
        },
      };
    },
  });
  const id = fixture.value.submit(request()).request_id;
  await step(fixture.value);
  await step(fixture.value);
  assert.equal(fixture.value.inspect(id).state, "rejected");
  assert.equal(posts, 1);
  const receipts = Array.from({ length: 16 }, () =>
    fixture.value.submit(request()),
  );
  assert.throws(() => fixture.value.submit(request()), { code: "QUEUE_FULL" });
  assert.equal(fixture.value.cancel(receipts[0].request_id).state, "cancelled");
  assert.equal(posts, 1);
});

test("running cancellation stays on the accepting peer and cannot publish a late success", async (t) => {
  const { service } = source(t, {
    generate: ({ signal }) =>
      new Promise((resolve, reject) =>
        signal.addEventListener(
          "abort",
          () => reject(new EngineError("CANCELLED")),
          { once: true },
        ),
      ),
  });
  const receiver = new DelegationReceiver({
    node_id: b.node_id,
    source: () => service,
  });
  const trace = [];
  const fixture = origin(t, { request: transport(receiver, trace) });
  const id = fixture.value.submit(request()).request_id;
  await step(fixture.value);
  service.tick();
  fixture.value.cancel(id);
  await step(fixture.value);
  await service.active?.task;
  await step(fixture.value);
  assert.equal(fixture.value.inspect(id).state, "cancelled");
  assert.throws(() => fixture.value.inspect(id, true));
  assert.equal(
    trace.filter((item) => item.route === "/peer/v1/delegations").length,
    1,
  );
});

test("invalid or mismatched remote results are discarded without storing private response fields", async (t) => {
  const { service } = source(t);
  const receiver = new DelegationReceiver({
    node_id: b.node_id,
    source: () => service,
  });
  const safe = transport(receiver, []);
  const fixture = origin(t, {
    request: async (options) => {
      const response = await safe(options);
      if (response.value.state === "completed")
        response.value.private = "private-response";
      return response;
    },
  });
  const id = fixture.value.submit(request()).request_id;
  await step(fixture.value);
  service.tick();
  await service.active?.task;
  await step(fixture.value);
  assert.equal(fixture.value.inspect(id).state, "unknown");
  assert.equal(fixture.value.inspect(id).error, "INVALID_RECEIPT");
  assert.doesNotMatch(
    JSON.stringify(fixture.value.store.all()),
    /private-response/,
  );
});

test("real mTLS delegates an entire request to one executor; machine authorization and peer scope remain separate", async (t) => {
  const first = source(t, { poll_ms: 10 });
  const second = source(t, { poll_ms: 10 });
  const receiver = new DelegationReceiver({
    node_id: b.node_id,
    source: () => second.service,
  });
  let trusted = trust(b, [entry(a)]);
  const target = create_peer_server({
    identity: b,
    get_peers: () => trusted,
    get_delegation: () => ({ receiver }),
  });
  target.server.listen(0, "127.0.0.1");
  await once(target.server, "listening");
  const selected = trust(a, [entry(b, target.server.address().port)])[0];
  const fixture = origin(t, {
    source: () => first.service,
    peers: () => [selected],
    poll_ms: 20,
    query_interval_ms: 500,
    min_peer_interval_ms: 500,
  });
  const app = create_app({
    inference: first.service,
    get_delegation: () => fixture.value,
  }).listen(0, "127.0.0.1");
  await once(app, "listening");
  try {
    const base = `http://127.0.0.1:${app.address().port}`;
    const headers = {
      "content-type": "application/json",
      "x-fracto-ai-token": first.service.store.token,
    };
    assert.equal(
      (
        await fetch(`${base}/inference/delegations`, {
          method: "POST",
          body: JSON.stringify(request()),
        })
      ).status,
      401,
    );
    const profile = await fixture.value.capabilities(b.node_id);
    assert.equal(profile.model_digest, digest);
    const response = await fetch(`${base}/inference/delegations`, {
      method: "POST",
      headers,
      body: JSON.stringify(request()),
    });
    assert.equal(response.status, 202);
    const receipt = await response.json();
    await wait_for(
      () => fixture.value.inspect(receipt.request_id).state === "completed",
    );
    assert.equal(first.state.calls, 0);
    assert.equal(second.state.calls, 1);
    assert.equal(first.service.store.all().length, 0);
    assert.equal(second.service.store.all().length, 1);
    const result = await (
      await fetch(
        `${base}/inference/delegations/${receipt.request_id}/result`,
        { headers },
      )
    ).json();
    assert.equal(result.executor_node_id, b.node_id);
    assert.equal(result.trust, "untrusted_evidence");
    assert.doesNotMatch(JSON.stringify(result), /private|model":|url|cookie/);
    trusted = trust(b, [entry(a, 3447, ["status:read"])]);
    const denied = await peer_request({
      identity: a,
      peer: selected,
      route: "/peer/v1/delegations/capabilities",
    });
    assert.equal(denied.status, 403);
    trusted = trust(b, [entry(a)]);
    const original_insert = second.service.store.insert.bind(
      second.service.store,
    );
    second.service.store.insert = (job) => {
      original_insert(job);
      throw new Error("private post-commit failure");
    };
    const ambiguous = fixture.value.submit(request());
    await wait_for(
      () => fixture.value.inspect(ambiguous.request_id).state === "unknown",
    );
    assert.equal(second.service.store.all().length, 2);
    await second.reopen();
    await wait_for(
      () => fixture.value.inspect(ambiguous.request_id).state === "completed",
    );
    assert.equal(second.state.calls, 2);
    assert.equal(second.service.store.all().length, 2);
    assert.equal(first.state.calls, 0);
    assert.equal((await fetch(`${base}/readyz`)).status, 200);
  } finally {
    await fixture.value.close();
    await new Promise((resolve) => app.close(resolve));
    target.disconnect();
    await new Promise((resolve) => target.server.close(resolve));
  }
});

test("revocation during admission prevents new work without breaking the local queue", async (t) => {
  const { service } = source(t);
  let granted = true;
  service.adapter.status = async () => {
    granted = false;
    return { state: "ready" };
  };
  const receiver = new DelegationReceiver({
    node_id: b.node_id,
    source: () => service,
    authorize: () => granted,
  });
  await assert.rejects(receiver.accept(a.node_id, wire()), {
    code: "SCOPE_DENIED",
  });
  assert.equal(service.store.all().length, 0);
  assert.equal(service.broken, false);
});

test("a crash with a persisted submission intent recovers as unknown and queries without POST", async (t) => {
  const trace = [];
  const fixture = origin(t, {
    request: async (options) => {
      trace.push(options.method || "GET");
      return {
        status: 404,
        value: { contract_version: 1, error: "DELEGATION_NOT_FOUND" },
      };
    },
  });
  const id = fixture.value.submit(request()).request_id;
  const row = fixture.value.store.get(id);
  row.state = "submitting";
  fixture.value.store.save(row);
  await fixture.reopen();
  assert.equal(fixture.value.inspect(id).state, "unknown");
  await step(fixture.value);
  assert.deepEqual(trace, ["GET"]);
  assert.equal(fixture.value.inspect(id).reconciling, true);
});
