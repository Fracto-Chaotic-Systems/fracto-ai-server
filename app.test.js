import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import {
  configured_port,
  configured_host,
  create_app,
  SERVICE_NAME,
} from "./app.js";

test("foundation health needs no model, database, or credentials", async (t) => {
  const server = create_app().listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const path of ["/", "/healthz", "/readyz"]) {
    const response = await fetch(`${base}${path}`, {
      headers: {
        cookie: "private-session=secret",
        "x-test-identity": "private",
      },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.deepEqual(Object.keys(body).sort(), [
      "capabilities",
      "contract_version",
      "service",
      "stage",
      "status",
      "uptime_seconds",
    ]);
    assert.equal(body.service, SERVICE_NAME);
    assert.equal(body.contract_version, 1);
    assert.equal(body.status, "ready");
    assert.equal(body.stage, "foundation");
    assert.deepEqual(body.capabilities, []);
    assert.ok(Number.isInteger(body.uptime_seconds));
  }
  for (const [method, path] of [
    ["POST", "/jobs"],
    ["POST", "/healthz"],
    ["GET", "/private-identity"],
  ]) {
    const response = await fetch(`${base}${path}`, { method });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "Not found" });
  }
});

test("listener configuration rejects invalid ports", () => {
  assert.equal(configured_host("127.0.0.1"), "127.0.0.1");
  assert.equal(configured_host("0.0.0.0"), "0.0.0.0");
  assert.throws(() => configured_host("remote.invalid"));
  assert.equal(configured_port("3107"), 3107);
  for (const value of ["", " ", "0", "65536", "3007.5", "NaN", "-1", "3e3"]) {
    assert.throws(() => configured_port(value), /Invalid FRACTO_AI_PORT/);
  }
});

test("engine status is allowlisted and does not change foundation readiness", async (t) => {
  const server = create_app({
    engine_status: async () => ({
      engine: "ollama",
      state: "model_missing",
      adapter_implemented: true,
      engine_version: "0.40.14-private",
      model_count: 0,
      model_configured: true,
      endpoint_url: "private-endpoint",
      model_name: "private-model",
      user: "private-identity",
      adapter_features: {
        generation: true,
        json_schema: true,
        private: "secret",
      },
    }),
  }).listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(
    `${base}/engine/status?engine=private&url=private`,
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(body.contract_version, 1);
  assert.equal(body.state, "model_missing");
  assert.equal(body.available_engines.ollama, "implemented");
  assert.equal(body.available_engines.vllm, "unavailable");
  assert.equal(JSON.stringify(body).includes("private"), false);
  assert.equal(body.adapter_features.streaming, false);
  assert.equal(body.adapter_features.embeddings, false);
  assert.equal((await fetch(`${base}/readyz`)).status, 200);
  assert.equal(
    (await fetch(`${base}/engine/generate`, { method: "POST" })).status,
    404,
  );
});

test("unexpected engine errors return only a fixed status code/message", async (t) => {
  const server = create_app({
    engine_status: async () => {
      throw new Error("private provider details");
    },
  }).listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, "listening");
  const body = await fetch(
    `http://127.0.0.1:${server.address().port}/engine/status`,
  ).then((response) => response.json());
  assert.equal(body.state, "engine_unavailable");
  assert.equal(body.error, "ENGINE_UNAVAILABLE");
  assert.equal(JSON.stringify(body).includes("private"), false);
});
