import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import test from "node:test";
import { start_windows_ollama } from "./ollama_windows.js";

test("Ollama bootstraps only for enabled Windows installations", () => {
  const calls = [];
  const child = new EventEmitter();
  const spawn_process = (...args) => {
    calls.push(args);
    return child;
  };
  assert.equal(
    start_windows_ollama({ platform: "linux", spawn_process }),
    false,
  );
  assert.equal(
    start_windows_ollama({
      platform: "win32",
      environment: { FRACTO_OLLAMA_ENABLED: "false" },
      spawn_process,
    }),
    false,
  );
  assert.equal(
    start_windows_ollama({ platform: "win32", environment: {}, spawn_process }),
    true,
  );
  assert.equal(calls.length, 1);
  assert.equal(
    start_windows_ollama({
      platform: "win32",
      environment: { FRACTO_AI_ENGINE: "sglang" },
      spawn_process,
    }),
    false,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "powershell.exe");
  assert.equal(calls[0][2].windowsHide, true);
  assert.equal(calls[0][2].stdio, "ignore");
});

test("Ollama bootstrap failure never throws into Fracto startup", () => {
  let errors = 0;
  assert.equal(
    start_windows_ollama({
      platform: "win32",
      environment: {},
      spawn_process: () => {
        throw new Error("blocked");
      },
      on_error: () => errors++,
    }),
    false,
  );
  assert.equal(errors, 1);
});

test("pinned package metadata uses an official version-specific URL and checksum", () => {
  const release = JSON.parse(
    fs.readFileSync(new URL("./ollama_release.json", import.meta.url), "utf8"),
  );
  assert.match(release.version, /^\d+\.\d+\.\d+$/);
  assert.equal(
    release.windows_amd64.url,
    `https://github.com/ollama/ollama/releases/download/v${release.version}/ollama-windows-amd64.zip`,
  );
  assert.match(release.windows_amd64.sha256, /^[a-f0-9]{64}$/);
});
