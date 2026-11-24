import fs from "node:fs/promises";
import path from "node:path";
import { construction_request } from "./contracts.js";
// Local executable caller only: never opens a second store or exports credentials.
export async function create_local_construction_client({
  environment = process.env,
  request = fetch,
} = {}) {
  const directory =
    environment.FRACTO_AI_DATA_DIR ||
    path.join(import.meta.dirname, "../runtime/inference");
  const token =
    environment.FRACTO_AI_INFERENCE_TOKEN ||
    (await fs.readFile(path.join(directory, "machine-token"), "utf8"));
  const port = Number(environment.FRACTO_AI_PORT || 3007);
  if (
    !/^[a-f0-9]{64}$/.test(token) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw new Error("CONSTRUCTION_CLI_CONFIG");
  return async (body, { signal } = {}) => {
    body = construction_request(body);
    const response = await request(
      `http://127.0.0.1:${port}/inference/construction/plan`,
      {
        method: "POST",
        redirect: "manual",
        headers: {
          "Content-Type": "application/json",
          "X-Fracto-AI-Token": token,
        },
        body: JSON.stringify(body),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(180000)])
          : AbortSignal.timeout(180000),
      },
    );
    const reader = response.body.getReader(),
      chunks = [];
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 256 * 1024) throw new Error("CONSTRUCTION_CLI_RESPONSE");
        chunks.push(value);
      }
      const result = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
      );
      if (!response.ok) {
        const error = new Error(
          typeof result.error === "string" && /^[A-Z_]+$/.test(result.error)
            ? result.error
            : "CONSTRUCTION_CLI_UNAVAILABLE",
        );
        error.status = response.status;
        throw error;
      }
      return result;
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  };
}
