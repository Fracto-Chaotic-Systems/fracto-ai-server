import assert from "node:assert/strict";
import test from "node:test";
import { StartupObserver } from "./startup_observer.js";

const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";
const health = (id) => ({
  contract_version: 1,
  startup_id: id,
  uptime_seconds: 10,
  services: { data: "healthy" },
});
const drain = async (observer) => {
  await observer.active?.done;
};

test("one collection per startup; persisted reports suppress repeats after observer restart", async () => {
  let calls = 0;
  const saved = new Set();
  const observer = new StartupObserver({
    read_health: async () => health(first),
    has_report: (id) => saved.has(id),
    collect: async (id) => {
      calls++;
      saved.add(id);
      return "report.json";
    },
  });
  await observer.tick();
  await drain(observer);
  await observer.tick();
  assert.equal(calls, 1);
  assert.equal(observer.current.state, "completed");
  const restarted = new StartupObserver({
    read_health: async () => health(first),
    has_report: (id) => saved.has(id),
    collect: async () => {
      calls++;
    },
  });
  await restarted.tick();
  assert.equal(calls, 1);
  assert.equal(restarted.current.state, "completed");
});

test("a new startup cancels an old run and ignores its late completion", async () => {
  let id = first;
  const runs = [];
  const observer = new StartupObserver({
    read_health: async () => health(id),
    collect: (runId, signal) =>
      new Promise((resolve) => runs.push({ runId, signal, resolve })),
  });
  await observer.tick();
  await Promise.resolve();
  id = second;
  await observer.tick();
  await Promise.resolve();
  assert.equal(runs[0].signal.aborted, true);
  runs[0].resolve("old.json");
  runs[1].resolve("new.json");
  await drain(observer);
  assert.equal(observer.current.id, second);
  assert.equal(observer.current.report_file, "new.json");
});

test("offline and non-Fracto responses do not start work; failures retry with a bound", async () => {
  let body = null,
    now = 10000,
    calls = 0;
  const observer = new StartupObserver({
    read_health: async () => body,
    now: () => now,
    retry_ms: 100,
    max_attempts: 2,
    collect: async () => {
      calls++;
      throw new Error("failure");
    },
  });
  await observer.tick();
  body = { ...health("../../bad"), services: [] };
  await observer.tick();
  assert.equal(calls, 0);
  body = health(first);
  await observer.tick();
  await drain(observer);
  await observer.tick();
  assert.equal(calls, 1);
  now += 100;
  await observer.tick();
  await drain(observer);
  now += 100;
  await observer.tick();
  assert.equal(calls, 2);
  assert.equal(observer.current.state, "failed");
});

test("legacy uptime rounding is stable and a process restart creates a fresh run", async () => {
  let now = 100000,
    uptime = 10,
    calls = 0;
  const observer = new StartupObserver({
    now: () => now,
    read_health: async () => ({ ...health(undefined), uptime_seconds: uptime }),
    collect: async () => {
      calls++;
      return "legacy.json";
    },
  });
  await observer.tick();
  await drain(observer);
  now += 5000;
  uptime += 4;
  await observer.tick();
  assert.equal(calls, 1);
  now += 20000;
  uptime = 1;
  await observer.tick();
  await drain(observer);
  assert.equal(calls, 2);
});

test("status write failures do not interrupt collection", async () => {
  const observer = new StartupObserver({
    read_health: async () => health(first),
    on_state: () => {
      throw new Error("disk unavailable");
    },
    collect: async () => "report.json",
  });
  await observer.tick();
  await drain(observer);
  assert.equal(observer.current.state, "completed");
});

test("restart preserves the retry budget and backoff for the same startup", async () => {
  let calls = 0,
    now = 1000;
  const exhausted = new StartupObserver({
    read_health: async () => health(first),
    read_state: () => ({ attempts: 3, retry_at: 0 }),
    collect: async () => {
      calls++;
    },
  });
  await exhausted.tick();
  assert.equal(calls, 0);
  assert.equal(exhausted.current.state, "failed");
  const delayed = new StartupObserver({
    read_health: async () => health(first),
    now: () => now,
    read_state: () => ({ attempts: 1, retry_at: 2000 }),
    collect: async () => {
      calls++;
      return "report.json";
    },
  });
  await delayed.tick();
  assert.equal(calls, 0);
  now = 2000;
  await delayed.tick();
  await drain(delayed);
  assert.equal(calls, 1);
  assert.equal(delayed.current.attempts, 2);
});
