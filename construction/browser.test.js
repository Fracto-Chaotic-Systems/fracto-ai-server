import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { once } from "node:events";
import { construction_browser_router } from "./browser.js";
import { construction_request } from "./contracts.js";
import { create_component_document } from "@fracto/sdk/FractoComponentDocument.js";
import { randomUUID } from "node:crypto";
import { fail } from "../inference/contracts.js";

async function fixture(t, options = {}) {
  const calls = [];
  const app = express();
  app.use(
    "/construction",
    construction_browser_router(
      {
        async construction_plan(body, { signal }) {
          construction_request(body);
          calls.push({ body, signal });
          if (options.plan) return options.plan(body, signal);
          return { applied: false, commands: [] };
        },
      },
      {
        authorize: (req, res, next) =>
          req.headers["x-test-auth"] === "enabled"
            ? next()
            : res.status(401).json({ error: "UNAUTHORIZED" }),
      },
    ),
  );
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const request = (body, headers = {}, suffix = "/plan") =>
    fetch(`http://127.0.0.1:${server.address().port}/construction${suffix}`, {
      method: "POST",
      headers: {
        Origin:
          process.env.FRACTO_UI_ORIGIN ||
          `http://localhost:${process.env.FRACTO_UI_PORT || 3006}`,
        "Content-Type": "application/json",
        "X-Test-Auth": "enabled",
        ...headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  return {
    calls,
    request,
    url: `http://127.0.0.1:${server.address().port}/construction/plan`,
  };
}
const body = () => ({
  contract_version: 1,
  brief: "A plain floor.",
  document: create_component_document(randomUUID(), "Path"),
});
test("browser planning authorizes trusted origin before parsing and exposes only the dedicated capability", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.request("bad json", { Origin: "http://untrusted.invalid" }))
      .status,
    403,
  );
  assert.equal(
    (await f.request("bad json", { "X-Test-Auth": "disabled" })).status,
    401,
  );
  assert.equal((await f.request(body(), {}, "/inference/chat")).status, 404);
  assert.equal((await f.request({ ...body(), model: "override" })).status, 400);
  assert.equal((await f.request(body(), {}, "/plan?private=yes")).status, 400);
  assert.equal(f.calls.length, 0);
  const response = await f.request(body(), {
    Cookie: "session=private",
    "X-Fracto-AI-Token": "untrusted",
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(f.calls.length, 1);
  assert.deepEqual(Object.keys(f.calls[0].body).sort(), [
    "brief",
    "contract_version",
    "document",
  ]);
  assert.ok(!JSON.stringify(await response.json()).includes("private"));
});
test("browser planning bounds requests, maps engine errors and rate limits without identity tracking", async (t) => {
  const large = await fixture(t);
  assert.equal(
    (
      await large.request(
        JSON.stringify({ ...body(), brief: "x".repeat(1024 * 1024) }),
      )
    ).status,
    413,
  );
  const error = await fixture(t, {
    plan: () => fail("DEADLINE_EXCEEDED", 504),
  });
  const response = await error.request(body());
  assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), { error: "DEADLINE_EXCEEDED" });
  const limited = await fixture(t);
  for (let i = 0; i < 6; i++)
    assert.equal((await limited.request(body())).status, 200);
  assert.equal((await limited.request(body())).status, 429);
});
test("disconnect cancels the browser planner request", async (t) => {
  let started, aborted;
  const entered = new Promise((resolve) => (started = resolve)),
    cancelled = new Promise((resolve) => (aborted = resolve));
  const f = await fixture(t, {
    plan: (body, signal) =>
      new Promise((resolve, reject) => {
        started();
        signal.addEventListener(
          "abort",
          () => {
            aborted();
            reject(new Error("cancelled"));
          },
          { once: true },
        );
      }),
  });
  const controller = new AbortController();
  const pending = fetch(f.url, {
    method: "POST",
    headers: {
      Origin:
        process.env.FRACTO_UI_ORIGIN ||
        `http://localhost:${process.env.FRACTO_UI_PORT || 3006}`,
      "Content-Type": "application/json",
      "X-Test-Auth": "enabled",
    },
    body: JSON.stringify(body()),
    signal: controller.signal,
  });
  await entered;
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  await Promise.race([
    cancelled,
    new Promise((resolve, reject) =>
      setTimeout(
        () => reject(new Error("disconnect not cancelled")),
        1000,
      ).unref(),
    ),
  ]);
});
