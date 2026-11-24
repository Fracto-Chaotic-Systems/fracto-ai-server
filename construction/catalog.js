import { internal_service_headers } from "@fracto/sdk/utils/ServiceAuthorization.js";
import { material_view } from "@fracto/sdk/FractoMaterialMetadata.js";
import { validate_material_query } from "@fracto/sdk/FractoMaterialSearch.js";
import { asset_relative_path } from "@fracto/sdk/FractoAssetArchive.js";
import { fail } from "../inference/contracts.js";

export function create_construction_catalog({
  environment = process.env,
  request = fetch,
} = {}) {
  const port = Number(environment.FRACTO_ASSET_PORT || 3003);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("CONSTRUCTION_CONFIGURATION");
  const base = `http://127.0.0.1:${port}/environment-catalog`;
  const read = async (path, signal) => {
    let response;
    try {
      response = await request(base + path, {
        method: "GET",
        headers: internal_service_headers(),
        redirect: "manual",
        signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      });
    } catch {
      if (signal?.aborted) signal.throwIfAborted();
      fail("CONSTRUCTION_CATALOG_UNAVAILABLE", 503);
    }
    if (!response.ok) {
      await response.body?.cancel();
      fail(
        response.status === 409
          ? "CONSTRUCTION_CATALOG_CHANGED"
          : "CONSTRUCTION_CATALOG_UNAVAILABLE",
        response.status === 409 ? 409 : 503,
      );
    }
    const reader = response.body?.getReader();
    if (
      !reader ||
      !response.headers.get("content-type")?.includes("application/json")
    ) {
      await response.body?.cancel();
      fail("CONSTRUCTION_CATALOG_UNAVAILABLE", 503);
    }
    const chunks = [];
    let bytes = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        bytes += item.value.byteLength;
        if (bytes > 256 * 1024) {
          await reader.cancel();
          fail("CONSTRUCTION_CATALOG_UNAVAILABLE", 503);
        }
        chunks.push(item.value);
      }
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
      );
    } catch {
      fail("CONSTRUCTION_CATALOG_UNAVAILABLE", 503);
    } finally {
      reader.releaseLock();
    }
  };
  const projection = (material) => material_view(material, material.revision);
  return {
    async search(q, signal) {
      validate_material_query({ q, limit: 4 });
      const result = await read(
        `/materials/search?${new URLSearchParams({ q, limit: "4" })}`,
        signal,
      );
      try {
        if (
          result.contract_version !== 1 ||
          !Array.isArray(result.materials) ||
          result.materials.length > 4 ||
          !Number.isInteger(result.total) ||
          result.total < result.materials.length ||
          !/^[a-f0-9]{64}$/.test(result.snapshot)
        )
          throw new Error();
        const materials = result.materials.map(projection);
        if (new Set(materials.map((item) => item.id)).size !== materials.length)
          throw new Error();
        return { total: result.total, materials, snapshot: result.snapshot };
      } catch {
        fail("CONSTRUCTION_CATALOG_UNAVAILABLE", 503);
      }
    },
    async resolve(reference, signal) {
      const result = await read(
        `/${encodeURIComponent(reference.id)}/construction/runtime?revision=${encodeURIComponent(reference.revision)}`,
        signal,
      );
      try {
        const material = projection(result.material),
          runtime = result.runtime;
        if (
          material.id !== reference.id ||
          material.revision !== reference.revision ||
          runtime.id !== reference.id ||
          !Array.isArray(runtime.resources) ||
          runtime.resources.length > 2000 ||
          runtime.resources.some(
            (file) =>
              typeof file !== "string" || asset_relative_path(file) !== file,
          ) ||
          (runtime.model !== null &&
            (typeof runtime.model !== "string" ||
              !runtime.resources.includes(runtime.model))) ||
          (runtime.format !== null &&
            (typeof runtime.format !== "string" || runtime.format.length > 16))
        )
          throw new Error();
        return {
          material,
          runtime: {
            id: runtime.id,
            model: runtime.model,
            format: runtime.format,
            resources: [...new Set(runtime.resources)],
          },
        };
      } catch {
        fail("CONSTRUCTION_CATALOG_UNAVAILABLE", 503);
      }
    },
  };
}
