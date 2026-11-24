import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import test from "node:test";

for (const scenario of [
  "copy",
  "corrupt source",
  "different destination",
  "nested destination",
]) {
  test(
    `managed model storage: ${scenario}`,
    { skip: process.platform !== "win32" },
    (t) => {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "fracto-model-storage-"),
      );
      t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
      for (const file of [
        "ollama_storage.ps1",
        "migrate_ollama_models_windows.ps1",
      ])
        fs.copyFileSync(
          new URL(file, import.meta.url),
          path.join(directory, file),
        );
      const source = path.join(directory, "runtime", "ollama", "models");
      const destination =
        scenario === "nested destination"
          ? path.join(source, "nested")
          : path.join(directory, "nvme");
      const content = Buffer.from("fixture weights");
      const blob = `sha256-${createHash("sha256").update(content).digest("hex")}`;
      fs.mkdirSync(path.join(source, "blobs"), { recursive: true });
      fs.mkdirSync(path.join(source, "manifests", "fixture"), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(source, "blobs", blob),
        scenario === "corrupt source" ? "corrupt" : content,
      );
      fs.writeFileSync(
        path.join(source, "manifests", "fixture", "latest"),
        '{"fixture":true}',
      );
      fs.mkdirSync(path.join(source, "manifests-v2", "fixture"), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(source, "manifests-v2", "fixture", "latest"),
        '{"version":2}',
      );
      fs.mkdirSync(path.join(source, "metadata"));
      fs.writeFileSync(
        path.join(source, "metadata", `${blob}.json`),
        '{"metadata":true}',
      );
      if (scenario === "different destination") {
        fs.mkdirSync(path.join(destination, "blobs"), { recursive: true });
        fs.writeFileSync(path.join(destination, "blobs", blob), "preserve");
      }
      const run = () =>
        spawnSync(
          process.env.FRACTO_TEST_POWERSHELL || "powershell.exe",
          [
            "-NoProfile",
            "-File",
            path.join(directory, "migrate_ollama_models_windows.ps1"),
            "-ModelsDirectory",
            destination,
          ],
          { encoding: "utf8", timeout: 15000, windowsHide: true },
        );
      const result = run();
      assert.ifError(result.error);
      const configuration = path.join(
        directory,
        "runtime",
        "ollama",
        "storage.json",
      );
      if (scenario === "copy") {
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(
          fs.readFileSync(path.join(destination, "blobs", blob)),
          content,
        );
        assert.equal(
          fs.readFileSync(
            path.join(destination, "manifests", "fixture", "latest"),
            "utf8",
          ),
          '{"fixture":true}',
        );
        assert.equal(
          fs.readFileSync(
            path.join(destination, "manifests-v2", "fixture", "latest"),
            "utf8",
          ),
          '{"version":2}',
        );
        assert.equal(
          fs.readFileSync(
            path.join(destination, "metadata", `${blob}.json`),
            "utf8",
          ),
          '{"metadata":true}',
        );
        assert.equal(
          JSON.parse(
            fs.readFileSync(configuration, "utf8").replace(/^\uFEFF/, ""),
          ).models_directory,
          destination,
        );
        assert.equal(run().status, 0, "verified repeat is safe");
      } else {
        assert.notEqual(result.status, 0);
        assert.equal(fs.existsSync(configuration), false);
        if (scenario === "different destination")
          assert.equal(
            fs.readFileSync(path.join(destination, "blobs", blob), "utf8"),
            "preserve",
          );
      }
      assert.equal(
        fs.readFileSync(path.join(source, "blobs", blob), "utf8"),
        scenario === "corrupt source" ? "corrupt" : content.toString(),
      );
    },
  );
}
