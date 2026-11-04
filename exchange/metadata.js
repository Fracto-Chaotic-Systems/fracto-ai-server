import { ENGINE_IDS } from "../engines/contracts.js";
import { deny, digest_id, exact, integer } from "./contracts.js";

export const PROFILE = Object.freeze({
  profile_version: 1,
  template_version: 1,
  schema_version: 1,
  operation: "assess_performance",
  context_tokens: 4096,
  cpu_threads: 2,
  temperature: 0,
  max_output_tokens: 512,
});
export const empty_metadata = () => ({
  contract_version: 1,
  available: false,
  engine: null,
  engine_version: null,
  models: [],
  profile: { ...PROFILE },
});
export const metadata_contract = (value) => {
  exact(value, [
    "contract_version",
    "available",
    "engine",
    "engine_version",
    "models",
    "profile",
  ]);
  exact(value.profile, Object.keys(PROFILE));
  if (
    value.contract_version !== 1 ||
    typeof value.available !== "boolean" ||
    !(value.engine === null || ENGINE_IDS.includes(value.engine)) ||
    !(
      value.engine_version === null ||
      (typeof value.engine_version === "string" &&
        value.engine_version.length <= 32 &&
        /^\d+\.\d+\.\d+$/.test(value.engine_version))
    ) ||
    !Array.isArray(value.models) ||
    value.models.length > 16 ||
    Object.keys(PROFILE).some((key) => value.profile[key] !== PROFILE[key]) ||
    (!value.available && (value.models.length || value.engine_version !== null))
  )
    deny("INVALID_METADATA");
  const seen = new Set();
  const models = value.models.map((model) => {
    exact(model, ["digest", "size_bytes"]);
    if (
      !digest_id(model.digest) ||
      !integer(model.size_bytes, 0) ||
      seen.has(model.digest)
    )
      deny("INVALID_METADATA");
    seen.add(model.digest);
    return { digest: model.digest, size_bytes: model.size_bytes };
  });
  return {
    contract_version: 1,
    available: value.available,
    engine: value.engine,
    engine_version: value.engine_version,
    models,
    profile: { ...PROFILE },
  };
};
/** Metadata-only adapter calls. No model names, pulls, loading or private URLs. */
export const collect_metadata = async (adapter, signal) => {
  if (!adapter) return empty_metadata();
  try {
    const [health, inventory] = await Promise.all([
      adapter.health({ timeout_ms: 1000, signal }),
      adapter.list_models({ timeout_ms: 1000, signal }),
    ]);
    const unique = new Map();
    for (const model of inventory)
      if (digest_id(model.digest) && integer(model.size_bytes, 0))
        unique.set(model.digest, {
          digest: model.digest,
          size_bytes: model.size_bytes,
        });
    return metadata_contract({
      contract_version: 1,
      available: true,
      engine: adapter.id,
      engine_version: health.version.split(/[-+]/)[0],
      models: [...unique.values()].slice(0, 16),
      profile: { ...PROFILE },
    });
  } catch {
    return empty_metadata();
  }
};
