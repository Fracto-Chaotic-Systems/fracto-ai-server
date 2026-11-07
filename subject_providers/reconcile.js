import path from "node:path";
import { read_source_file, bundle_fail } from "./bundle_sources.js";
import { validate_bundle, MAX_BUNDLE_BYTES } from "./bundle_contract.js";
import { provider_digest } from "./contracts.js";

/** Fixed local artifact admission. No extraction, checkout scanning or inference. */
export const read_ui_bundle = (
  root = path.resolve(import.meta.dirname, ".."),
) => {
  try {
    const decode = (bytes) =>
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const definition = decode(
      read_source_file(root, "subject_providers/ui.json", 32768),
    );
    const bundle = validate_bundle(
      decode(
        read_source_file(
          root,
          "generated/knowledge/ui-features.bundle.json",
          MAX_BUNDLE_BYTES,
        ),
      ),
    );
    if (bundle.manifest.provider_digest !== provider_digest(definition))
      bundle_fail("BUNDLE_PROVIDER_MISMATCH");
    return bundle;
  } catch (error) {
    if (error?.code === "BUNDLE_PROVIDER_MISMATCH") throw error;
    bundle_fail("BUNDLE_ADMISSION_FAILED");
  }
};

export const reconcile_ui_bundle = (store) =>
  store.reconcile_bundle(read_ui_bundle());
