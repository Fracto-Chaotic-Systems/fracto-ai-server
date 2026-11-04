import { EngineError, with_deadline } from "./errors.js";
import {
  exact_fields,
  FEATURES,
  generation_request,
  model_id,
} from "./contracts.js";
import { EngineTransport } from "./transport.js";
import { inventory, normalized_result, version } from "./protocol.js";

export class OllamaAdapter {
  constructor({
    base_url = "http://127.0.0.1:11434",
    model = null,
    fetch_impl,
    now = Date.now,
    allow_host_gateway = false,
  } = {}) {
    this.id = "ollama";
    this.features = FEATURES;
    this.model = model == null || model === "" ? null : model_id(model);
    this.transport = new EngineTransport({
      base_url,
      fetch_impl,
      allow_host_gateway,
    });
    this.now = now;
    this.phase = null;
    this.cached = null;
    this.pending_status = null;
  }

  async list_models(options = {}) {
    exact_fields(options, ["signal", "timeout_ms"]);
    return with_deadline(
      async (signal) =>
        inventory(await this.transport.json("/api/tags", { signal })),
      options,
    );
  }

  async health(options = {}) {
    exact_fields(options, ["signal", "timeout_ms"]);
    return with_deadline(
      async (signal) => ({
        available: true,
        version: version(await this.transport.json("/api/version", { signal })),
      }),
      options,
    );
  }

  /** Metadata only. No load/pull/warm-up happens during status reads. */
  async status() {
    if (!this.cached || this.now() - this.cached.at >= 5000) {
      if (!this.pending_status) {
        this.pending_status = with_deadline(
          async (signal) => {
            const [release, tags, loaded] = await Promise.all([
              this.transport.json("/api/version", { signal }),
              this.transport.json("/api/tags", { signal }),
              this.transport.json("/api/ps", { signal }),
            ]);
            if (!Array.isArray(loaded.models) || loaded.models.length > 1024)
              throw new EngineError("PROTOCOL_ERROR");
            const models = inventory(tags);
            const present =
              this.model !== null &&
              models.some((item) => item.id === this.model);
            let model_loaded = false;
            try {
              model_loaded =
                present &&
                loaded.models.some(
                  (item) => model_id(item.name) === this.model,
                );
            } catch {
              throw new EngineError("PROTOCOL_ERROR");
            }
            return {
              engine_version: version(release),
              state: present ? "ready" : "model_missing",
              model_count: models.length,
              model_configured: this.model !== null,
              model_present: present,
              model_loaded,
              error: null,
            };
          },
          { timeout_ms: 3000 },
        )
          .catch((error) => ({
            state: "engine_unavailable",
            engine_version: null,
            model_count: null,
            model_configured: this.model !== null,
            model_present: false,
            model_loaded: false,
            error:
              error instanceof EngineError ? error.code : "ENGINE_UNAVAILABLE",
          }))
          .then((value) => {
            this.cached = { at: this.now(), value };
          })
          .finally(() => {
            this.pending_status = null;
          });
      }
      await this.pending_status;
    }
    return {
      engine: this.id,
      adapter_implemented: true,
      adapter_features: { ...this.features },
      ...this.cached.value,
      ...(this.phase ? { state: this.phase } : {}),
      active_requests: this.phase ? 1 : 0,
      concurrency_limit: 1,
    };
  }

  async selected(signal) {
    if (!this.model) throw new EngineError("MODEL_MISSING");
    const [release, tags] = await Promise.all([
      this.transport.json("/api/version", { signal }),
      this.transport.json("/api/tags", { signal }),
    ]);
    const entry = inventory(tags).find((item) => item.id === this.model);
    if (!entry) throw new EngineError("MODEL_MISSING");
    const details = await this.transport.json("/api/show", {
      signal,
      model_request: true,
      body: { model: this.model },
    });
    if (details.remote_host || details.remote_model)
      throw new EngineError("UNSUPPORTED_OPERATION");
    if (!Array.isArray(details.capabilities))
      throw new EngineError("PROTOCOL_ERROR");
    if (!details.capabilities.includes("completion"))
      throw new EngineError("UNSUPPORTED_OPERATION");
    return {
      digest: entry.digest,
      engine_version: version(release),
      thinking: details.capabilities.includes("thinking"),
    };
  }

  async operation(phase, options, execute) {
    if (this.phase) throw new EngineError("ENGINE_BUSY");
    this.phase = phase;
    try {
      return await with_deadline(execute, options);
    } finally {
      this.phase = null;
      this.cached = null;
    }
  }

  async generate(input) {
    if (this.phase) throw new EngineError("ENGINE_BUSY");
    const request = generation_request(input);
    return this.operation("busy", request, async (signal) => {
      const selected = await this.selected(signal);
      if (
        request.expected_model_digest &&
        selected.digest !== request.expected_model_digest
      )
        throw new EngineError("MODEL_MISMATCH");
      const body = {
        model: this.model,
        messages: request.messages,
        stream: false,
        keep_alive: 0,
        options: {
          num_ctx: 4096,
          num_thread: 2,
          num_predict: request.max_tokens,
          temperature: request.temperature,
        },
        ...(selected.thinking ? { think: false } : {}),
        ...(request.schema ? { format: request.schema.schema } : {}),
      };
      const response = await this.transport.json("/api/chat", {
        signal,
        body,
        model_request: true,
      });
      return normalized_result(response, {
        model: this.model,
        ...selected,
        schema: request.schema,
      });
    });
  }

  async warmup(options = {}) {
    exact_fields(options, ["signal", "timeout_ms"]);
    return this.operation("warming", options, async (signal) => {
      const selected = await this.selected(signal);
      const response = await this.transport.json("/api/generate", {
        signal,
        model_request: true,
        body: {
          model: this.model,
          stream: false,
          keep_alive: "30s",
          options: { num_ctx: 4096, num_thread: 2 },
        },
      });
      if (response.done !== true) throw new EngineError("PROTOCOL_ERROR");
      return {
        engine: this.id,
        model: this.model,
        model_digest: selected.digest,
        engine_version: selected.engine_version,
        loaded: true,
      };
    });
  }

  async embed() {
    throw new EngineError("UNSUPPORTED_OPERATION");
  }
  async stream() {
    throw new EngineError("UNSUPPORTED_OPERATION");
  }
}
