import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  bundle_bytes,
  validate_bundle,
  MAX_BUNDLE_BYTES,
} from "./bundle_contract.js";
import { read_source_file, bundle_fail } from "./bundle_sources.js";

/** One artifact rename publishes the complete manifest and document snapshot. */
export const write_bundle = (ai_root, bundle, { check = false } = {}) => {
  validate_bundle(bundle);
  const relative = `generated/knowledge/${bundle.manifest.provider.provider_id}.bundle.json`;
  const content = bundle_bytes(bundle);
  const target = path.join(ai_root, relative);
  if (fs.existsSync(target)) {
    const current = read_source_file(ai_root, relative, MAX_BUNDLE_BYTES);
    if (current.equals(content)) return { path: target, changed: false };
  }
  if (check) bundle_fail("KNOWLEDGE_BUNDLE_STALE");
  let temporary, descriptor;
  try {
    if (
      !fs.lstatSync(ai_root).isDirectory() ||
      fs.lstatSync(ai_root).isSymbolicLink()
    )
      bundle_fail("BUNDLE_OUTPUT_UNAVAILABLE");
    let directory = ai_root;
    for (const segment of ["generated", "knowledge"]) {
      directory = path.join(directory, segment);
      if (!fs.existsSync(directory)) fs.mkdirSync(directory);
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        bundle_fail("BUNDLE_OUTPUT_UNAVAILABLE");
    }
    temporary = path.join(
      directory,
      `.${bundle.manifest.provider.provider_id}.${randomUUID()}.tmp`,
    );
    descriptor = fs.openSync(temporary, "wx", 0o644);
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, target);
    temporary = undefined;
    if (process.platform !== "win32") {
      const directory_handle = fs.openSync(directory, "r");
      try {
        fs.fsyncSync(directory_handle);
      } finally {
        fs.closeSync(directory_handle);
      }
    }
    return { path: target, changed: true };
  } catch {
    bundle_fail("BUNDLE_OUTPUT_UNAVAILABLE");
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (temporary) {
      try {
        fs.unlinkSync(temporary);
      } catch {}
    }
  }
};
