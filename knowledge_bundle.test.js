import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  generate_bundle,
  repository_roots,
} from "./subject_providers/bundle.js";
import {
  read_source_file,
  source_provenance,
  digest,
} from "./subject_providers/bundle_sources.js";
import {
  validate_bundle,
  bundle_bytes,
} from "./subject_providers/bundle_contract.js";
import { write_bundle } from "./subject_providers/bundle_output.js";
import { canonical } from "./subject_providers/validation.js";

const definition = () =>
  JSON.parse(
    fs.readFileSync(
      new URL("./subject_providers/ui.json", import.meta.url),
      "utf8",
    ),
  );
const catalog_file = path.join(
  repository_roots.ui,
  "src/features/catalog.json",
);
const has_ui = fs.existsSync(catalog_file);
const provenance = () => ({
  repository_revision: "a".repeat(40),
  source_state: "modified",
});
const fixture = (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fracto-bundle-"));
  t.after(() => {
    assert.equal(
      path.dirname(path.resolve(directory)),
      path.resolve(os.tmpdir()),
    );
    assert.ok(path.basename(directory).startsWith("fracto-bundle-"));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const ui = path.join(directory, "ui"),
    ai = path.join(directory, "ai");
  fs.mkdirSync(path.join(ui, "src/features"), { recursive: true });
  fs.mkdirSync(ai);
  if (has_ui)
    fs.copyFileSync(catalog_file, path.join(ui, "src/features/catalog.json"));
  return {
    directory,
    ui,
    ai,
    generate: (options = {}) =>
      generate_bundle({
        definition: definition(),
        roots: { ui },
        provenance,
        ...options,
      }),
  };
};
const seal = (bundle) => {
  bundle.digest = digest(
    canonical({
      contract_version: bundle.contract_version,
      manifest: bundle.manifest,
      documents: bundle.documents,
    }),
  );
  return bundle;
};

test(
  "bundle generation is byte-identical across repeats and relocated workspaces",
  { skip: !has_ui },
  async (t) => {
    const first = fixture(t),
      second = fixture(t);
    const a = await first.generate(),
      b = await second.generate();
    assert.ok(bundle_bytes(a).equals(bundle_bytes(b)));
    assert.ok(bundle_bytes(a).equals(bundle_bytes(await first.generate())));
    assert.equal(a.documents.length, 7);
    assert.equal(
      a.manifest.sources[0].digest,
      digest(fs.readFileSync(catalog_file)),
    );
    assert.equal(a.manifest.sources[0].source_state, "modified");
    assert.equal(a.manifest.generator.version, "1.0.0");
    assert.equal(a.manifest.extractor.version, "1.0.0");
    assert.ok(!bundle_bytes(a).toString().includes(first.directory));
    assert.ok(!Object.hasOwn(a.manifest, "generated_at"));
  },
);

test(
  "content changes revise affected documents while provenance-only changes preserve document revisions",
  { skip: !has_ui },
  async (t) => {
    const f = fixture(t),
      old = await f.generate();
    const file = path.join(f.ui, "src/features/catalog.json");
    const catalog = JSON.parse(fs.readFileSync(file, "utf8"));
    catalog.features.find((feature) => feature.id === "admin-chat").purpose +=
      " Updated reference.";
    fs.writeFileSync(file, JSON.stringify(catalog));
    const changed = await f.generate();
    assert.notEqual(old.digest, changed.digest);
    for (const document of old.manifest.documents) {
      const next = changed.manifest.documents.find(
        (entry) => entry.id === document.id,
      );
      if (document.id === "admin")
        assert.notEqual(document.revision, next.revision);
      else assert.equal(document.revision, next.revision);
    }
    const revision = await f.generate({
      provenance: () => ({
        repository_revision: "b".repeat(40),
        source_state: "committed",
      }),
    });
    assert.notEqual(changed.digest, revision.digest);
    assert.deepEqual(changed.manifest.documents, revision.manifest.documents);
  },
);

test(
  "bundle validation detects content, manifest and declaration tampering even after resealing",
  { skip: !has_ui },
  async (t) => {
    const original = await fixture(t).generate();
    for (const mutate of [
      (bundle) => {
        bundle.documents[0].text += "tampered";
      },
      (bundle) => {
        bundle.manifest.documents[0].source = "other-source";
      },
      (bundle) => {
        bundle.manifest.sources[0].path = "../.env";
      },
      (bundle) => {
        bundle.manifest.provider.limits.document_bytes = 65537;
      },
      (bundle) => {
        bundle.manifest.sources[0].repository_revision = "not-a-commit";
      },
      (bundle) => {
        bundle.documents.pop();
      },
      (bundle) => {
        bundle.manifest.generator.version = "99.0.0";
      },
      (bundle) => {
        bundle.private = "unknown field";
      },
    ]) {
      const value = structuredClone(original);
      mutate(value);
      seal(value);
      assert.throws(() => validate_bundle(value), /INVALID_KNOWLEDGE_BUNDLE/);
    }
  },
);

test("source reader rejects escapes, links, oversized files and concurrent changes", (t) => {
  const f = fixture(t),
    source = path.join(f.ui, "text.md");
  fs.writeFileSync(source, "text");
  assert.equal(read_source_file(f.ui, "text.md", 4).toString(), "text");
  assert.throws(
    () => read_source_file(f.ui, "text.md", 3),
    /BUNDLE_SOURCE_TOO_LARGE/,
  );
  assert.throws(
    () => read_source_file(f.ui, "../text.md", 100),
    /INVALID_BUNDLE_SOURCE/,
  );
  const outside = path.join(f.directory, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "text.md"), "outside");
  fs.symlinkSync(
    outside,
    path.join(f.ui, "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.throws(
    () => read_source_file(f.ui, "linked/text.md", 100),
    /INVALID_BUNDLE_SOURCE/,
  );
  const read = fs.readSync;
  try {
    let changed = false;
    fs.readSync = (...args) => {
      const count = read(...args);
      if (!changed) {
        changed = true;
        fs.appendFileSync(source, "more");
      }
      return count;
    };
    assert.throws(
      () => read_source_file(f.ui, "text.md", 100),
      /BUNDLE_SOURCE_CHANGED/,
    );
  } finally {
    fs.readSync = read;
  }
});

test(
  "generation enforces source input bounds and rejects unknown executable selectors",
  { skip: !has_ui },
  async (t) => {
    const f = fixture(t);
    const tiny = definition();
    tiny.limits.source_bytes = 1;
    await assert.rejects(
      f.generate({ definition: tiny }),
      /BUNDLE_SOURCE_TOO_LARGE/,
    );
    const unknown = definition();
    unknown.extractor.id = "shell-command";
    await assert.rejects(
      f.generate({ definition: unknown }),
      /UNSUPPORTED_BUNDLE_EXTRACTOR/,
    );
    const small_output = definition();
    small_output.limits.document_bytes = 1;
    await assert.rejects(
      f.generate({ definition: small_output }),
      /BUNDLE_EXTRACTION_FAILED/,
    );
    const aggregate = definition();
    const input_size = fs.statSync(
      path.join(f.ui, "src/features/catalog.json"),
    ).size;
    aggregate.sources.push({ id: "extra", repository: "ui", path: "extra.md" });
    aggregate.limits.source_bytes = input_size;
    aggregate.limits.total_source_bytes = input_size;
    fs.writeFileSync(path.join(f.ui, "extra.md"), "additional input");
    await assert.rejects(
      f.generate({ definition: aggregate }),
      /BUNDLE_SOURCE_TOO_LARGE/,
    );
    fs.writeFileSync(
      path.join(f.ui, "src/features/catalog.json"),
      Buffer.from([255]),
    );
    await assert.rejects(f.generate(), /INVALID_BUNDLE_SOURCE/);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(f.generate({ signal: controller.signal }), {
      name: "AbortError",
    });
  },
);

test(
  "artifact publication is idempotent, check-only is read-only and failed writes preserve the previous bundle",
  { skip: !has_ui },
  async (t) => {
    const f = fixture(t),
      bundle = await f.generate();
    assert.throws(
      () => write_bundle(f.ai, bundle, { check: true }),
      /KNOWLEDGE_BUNDLE_STALE/,
    );
    assert.equal(fs.existsSync(path.join(f.ai, "generated")), false);
    const first = write_bundle(f.ai, bundle);
    assert.equal(first.changed, true);
    fs.utimesSync(first.path, new Date(1000), new Date(1000));
    const before = fs.statSync(first.path).mtimeMs,
      bytes = fs.readFileSync(first.path);
    assert.equal(write_bundle(f.ai, bundle).changed, false);
    assert.equal(fs.statSync(first.path).mtimeMs, before);
    assert.equal(write_bundle(f.ai, bundle, { check: true }).changed, false);
    const next = await f.generate({
      provenance: () => ({
        repository_revision: "b".repeat(40),
        source_state: "modified",
      }),
    });
    assert.throws(
      () => write_bundle(f.ai, next, { check: true }),
      /KNOWLEDGE_BUNDLE_STALE/,
    );
    const rename = fs.renameSync;
    try {
      fs.renameSync = () => {
        throw new Error("fixture failure");
      };
      assert.throws(
        () => write_bundle(f.ai, next),
        /BUNDLE_OUTPUT_UNAVAILABLE/,
      );
    } finally {
      fs.renameSync = rename;
    }
    assert.ok(fs.readFileSync(first.path).equals(bytes));
    assert.deepEqual(fs.readdirSync(path.dirname(first.path)), [
      "ui-features.bundle.json",
    ]);
  },
);

test(
  "artifact output refuses linked directories without writing outside its root",
  { skip: !has_ui },
  async (t) => {
    const f = fixture(t),
      bundle = await f.generate();
    const outside = path.join(f.directory, "outside");
    fs.mkdirSync(outside);
    fs.symlinkSync(
      outside,
      path.join(f.ai, "generated"),
      process.platform === "win32" ? "junction" : "dir",
    );
    assert.throws(
      () => write_bundle(f.ai, bundle),
      /BUNDLE_OUTPUT_UNAVAILABLE/,
    );
    assert.deepEqual(fs.readdirSync(outside), []);
  },
);

test("Git provenance retains only revisions and scoped byte state, with an archive fallback", (t) => {
  const f = fixture(t),
    source = path.join(f.ai, "source.md");
  fs.writeFileSync(source, "fixture");
  assert.deepEqual(source_provenance(f.ai, "source.md", digest("fixture")), {
    repository_revision: null,
    source_state: "unknown",
  });
  const git = (...args) => {
    const result = spawnSync("git", ["-C", f.ai, ...args], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "-q");
  git("add", "source.md");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "fixture",
  );
  const revision = git("rev-parse", "HEAD");
  assert.deepEqual(source_provenance(f.ai, "source.md", digest("fixture")), {
    repository_revision: revision,
    source_state: "committed",
  });
  fs.writeFileSync(source, "changed");
  assert.equal(
    source_provenance(f.ai, "source.md", digest("changed")).source_state,
    "modified",
  );
  fs.writeFileSync(path.join(f.ai, "new.md"), "new");
  assert.equal(
    source_provenance(f.ai, "new.md", digest("new")).source_state,
    "unversioned",
  );
});
