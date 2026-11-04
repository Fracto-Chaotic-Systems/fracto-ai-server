import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { configured_port, create_app, SERVICE_NAME } from "./app.js";

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
  assert.equal(configured_port("3107"), 3107);
  for (const value of ["", " ", "0", "65536", "3007.5", "NaN", "-1", "3e3"]) {
    assert.throws(() => configured_port(value), /Invalid FRACTO_AI_PORT/);
  }
});
