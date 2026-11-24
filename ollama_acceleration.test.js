import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

for (const scenario of ["unchanged", "enabled", "disabled", "invalid"]) {
  test(
    `managed acceleration: ${scenario}`,
    { skip: process.platform !== "win32" },
    (t) => {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "fracto-acceleration-"),
      );
      t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
      fs.copyFileSync(
        new URL("ollama_acceleration.ps1", import.meta.url),
        path.join(directory, "helper.ps1"),
      );
      if (scenario !== "unchanged")
        fs.writeFileSync(
          path.join(directory, "acceleration.json"),
          JSON.stringify({
            schema_version: 1,
            integrated_gpu:
              scenario === "invalid" ? "true" : scenario === "enabled",
          }),
        );
      fs.writeFileSync(
        path.join(directory, "fixture.ps1"),
        `
      $ErrorActionPreference='Stop'
      . (Join-Path $PSScriptRoot 'helper.ps1')
      $env:OLLAMA_IGPU_ENABLE='original'; $env:OLLAMA_VULKAN='original'
      Set-FractoOllamaAccelerationEnvironment $PSScriptRoot
      @{igpu=$env:OLLAMA_IGPU_ENABLE;vulkan=$env:OLLAMA_VULKAN}|ConvertTo-Json -Compress
    `,
      );
      const result = spawnSync(
        process.env.FRACTO_TEST_POWERSHELL || "powershell.exe",
        ["-NoProfile", "-File", path.join(directory, "fixture.ps1")],
        {
          encoding: "utf8",
          timeout: 15000,
          windowsHide: true,
        },
      );
      assert.ifError(result.error);
      if (scenario === "invalid") {
        assert.notEqual(result.status, 0);
        return;
      }
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {
        igpu:
          scenario === "enabled"
            ? "1"
            : scenario === "disabled"
              ? "0"
              : "original",
        vulkan: scenario === "enabled" ? "1" : "original",
      });
    },
  );
}
