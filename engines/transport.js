import { EngineError } from "./errors.js";

export const local_base_url = (value, allow_host_gateway = false) => {
  try {
    const url = new URL(value);
    const hosts = [
      "localhost",
      "127.0.0.1",
      "[::1]",
      ...(allow_host_gateway === true ? ["host.docker.internal"] : []),
    ];
    if (
      url.protocol !== "http:" ||
      !hosts.includes(url.hostname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new EngineError("CONFIGURATION_ERROR");
  }
};

export class EngineTransport {
  constructor({ base_url, fetch_impl = fetch, allow_host_gateway = false }) {
    this.base_url = local_base_url(base_url, allow_host_gateway);
    this.fetch_impl = fetch_impl;
  }
  async json(route, { signal, body, model_request = false } = {}) {
    const response = await this.fetch_impl(`${this.base_url}${route}`, {
      method: body === undefined ? "GET" : "POST",
      redirect: "manual",
      signal,
      headers:
        body === undefined
          ? { Accept: "application/json" }
          : { Accept: "application/json", "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 404 && model_request)
        throw new EngineError("MODEL_MISSING");
      if ([429, 503].includes(response.status))
        throw new EngineError("ENGINE_BUSY");
      throw new EngineError("ENGINE_UNAVAILABLE");
    }
    if (!response.headers.get("content-type")?.includes("application/json")) {
      await response.body?.cancel();
      throw new EngineError("PROTOCOL_ERROR");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new EngineError("PROTOCOL_ERROR");
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 2 * 1024 * 1024) {
          await reader.cancel();
          throw new EngineError("PROTOCOL_ERROR");
        }
        chunks.push(value);
      }
      const parsed = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
      );
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        Object.hasOwn(parsed, "error")
      )
        throw new EngineError("PROTOCOL_ERROR");
      return parsed;
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof EngineError) throw error;
      throw new EngineError("PROTOCOL_ERROR");
    } finally {
      reader.releaseLock();
    }
  }
}
