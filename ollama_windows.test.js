import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
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
  for (const architecture of ["amd64", "arm64"]) {
    const entry = release[`windows_${architecture}`];
    assert.equal(
      entry.url,
      `https://github.com/ollama/ollama/releases/download/v${release.version}/ollama-windows-${architecture}.zip`,
    );
    assert.match(entry.sha256, /^[a-f0-9]{64}$/);
  }
});

// Run the real installer against disposable already-installed fixtures. No engine,
// download, global configuration or real runtime directory is touched.
for (const scenario of [
  { name: "native x64", process: "AMD64", installed: "amd64" },
  { name: "native ARM64", process: "ARM64", installed: "arm64" },
  { name: "emulated x64 on ARM64", process: "AMD64", native: "ARM64", installed: "arm64" },
  { name: "emulated x86 on x64", process: "x86", native: "AMD64", installed: "amd64" },
  { name: "legacy x64 record", process: "AMD64", installed: "amd64", legacy: true },
  { name: "legacy x64 record on ARM64", process: "ARM64", installed: "amd64", legacy: true, error: "different managed Ollama architecture" },
  { name: "ARM64 record on x64", process: "AMD64", installed: "arm64", error: "different managed Ollama architecture" },
  { name: "unknown architecture", process: "UNKNOWN", installed: "amd64", error: "requires x64 or ARM64 Windows" },
]) {
  test(`Windows installer: ${scenario.name}`, { skip: process.platform !== "win32" }, (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fracto-ollama-installer-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    for (const file of ["install_ollama_windows.ps1", "ollama_release.json"])
      fs.copyFileSync(new URL(file, import.meta.url), path.join(directory, file));
    const release = JSON.parse(fs.readFileSync(path.join(directory, "ollama_release.json"), "utf8"));
    const runtime = path.join(directory, "runtime", "ollama");
    const versionDirectory = path.join(runtime, release.version);
    fs.mkdirSync(versionDirectory, { recursive: true });
    fs.writeFileSync(path.join(versionDirectory, "ollama.exe"), "fixture, never executed");
    const record = {
      version: release.version,
      archive_sha256: release[`windows_${scenario.installed}`].sha256,
      ...(scenario.legacy ? {} : { architecture: scenario.installed }),
    };
    fs.writeFileSync(path.join(runtime, "installation.json"), JSON.stringify(record));
    // PowerShell can normalize architecture variables at process startup. Set
    // these synthetic inputs inside the fixture, before invoking the installer.
    const fixture = path.join(directory, "fixture.ps1");
    fs.writeFileSync(fixture, [
      `$env:PROCESSOR_ARCHITECTURE = '${scenario.process}'`,
      `$env:PROCESSOR_ARCHITEW6432 = '${scenario.native || ""}'`,
      "& (Join-Path $PSScriptRoot 'install_ollama_windows.ps1')",
      "if (-not $?) { exit 1 }",
    ].join("\n"));
    const result = spawnSync(process.env.FRACTO_TEST_POWERSHELL || "powershell.exe", ["-NoProfile", "-File", fixture], {
      encoding: "utf8", timeout: 15000, windowsHide: true,
    });
    assert.ifError(result.error);
    if (scenario.error) {
      assert.notEqual(result.status, 0);
      assert.ok(result.stderr.includes(scenario.error), result.stderr);
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Pinned Ollama installation already available/);
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runtime, "installation.json"), "utf8")), record);
    assert.deepEqual(fs.readdirSync(runtime).sort(), [release.version, "installation.json"].sort());
  });
}
