import { randomUUID } from "node:crypto";
import os from "node:os";
import { EngineError, with_deadline } from "../engines/errors.js";
import { chat_messages } from "./chat.js";
import { ENGINE_IDS } from "../engines/contracts.js";
import {
  fail,
  hash,
  InferenceError,
  messages_for,
  normalize_request,
  public_job,
  schema,
  validate_output,
} from "./contracts.js";
import { is_terminal } from "./storage.js";

const number_or_null = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
export class InferenceService {
  constructor({
    store,
    adapter,
    now = Date.now,
    free_memory = os.freemem,
    min_memory_bytes = 6 * 1024 ** 3,
    min_disk_bytes = 1024 ** 3,
    pending_limit = 16,
    poll_ms = 250,
    app_reference = null,
  }) {
    this.store = store;
    this.adapter = adapter;
    this.now = now;
    this.free_memory = free_memory;
    this.min_memory_bytes = min_memory_bytes;
    this.min_disk_bytes = min_disk_bytes;
    this.pending_limit = pending_limit;
    this.stopping = false;
    this.broken = false;
    this.active = null;
    this.chat_active = null;
    this.app_reference = app_reference;
    this.reference_active = new Set();
    this.last_maintenance = now();
    // Never replay an ambiguous generation after a crash or graceful shutdown.
    for (const job of store.all()) {
      store.read_artifact(job.input_hash);
      if (job.result_hash) store.read_artifact(job.result_hash);
      if (["running", "cancelling"].includes(job.state)) {
        job.state = job.state === "cancelling" ? "cancelled" : "interrupted";
        job.error = job.state === "cancelled" ? "CANCELLED" : "INTERRUPTED";
        job.finished_at = now();
        store.save(job);
      }
      if (
        job.state === "queued" &&
        (job.engine !== adapter.id || job.model !== adapter.model)
      ) {
        job.state = "failed";
        job.error = "CONFIGURATION_CHANGED";
        job.finished_at = now();
        store.save(job);
      }
    }
    store.maintain(now());
    this.timer = setInterval(() => this.tick(), poll_ms);
    this.timer.unref();
  }
  available() {
    if (this.stopping || this.broken) fail("INFERENCE_UNAVAILABLE", 503);
  }
  resources() {
    if (this.free_memory() < this.min_memory_bytes)
      fail("MEMORY_PRESSURE", 503);
    if (this.store.free_bytes() < this.min_disk_bytes)
      fail("DISK_PRESSURE", 503);
  }
  protect(operation) {
    try {
      return operation();
    } catch (error) {
      if (error.code === "STORAGE_UNAVAILABLE") this.break_storage();
      if (error instanceof InferenceError) throw error;
      this.break_storage();
      fail("STORAGE_UNAVAILABLE", 503);
    }
  }
  break_storage() {
    this.broken = true;
    this.active?.controller.abort();
    this.chat_active?.controller.abort();
    for (const request of this.reference_active) request.controller.abort();
  }
  async chat(body, { signal, on_delta } = {}) {
    this.available();
    const messages = chat_messages(body);
    if (body.mode === "app-reference")
      return this.reference_chat(messages.at(-1).content, { signal, on_delta });
    this.protect(() => {
      this.resources();
      if (
        this.active ||
        this.chat_active ||
        this.store.all().some((job) => job.state === "queued")
      )
        fail("ENGINE_BUSY", 429);
    });
    const controller = new AbortController();
    const combined = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    const task = with_deadline(
      async (deadline_signal) => {
        const request = {
          messages,
          max_tokens: 512,
          temperature: 0.2,
          timeout_ms: 175000,
          signal: deadline_signal,
        };
        let streamed = "";
        const result = on_delta
          ? await this.adapter.stream(request, {
              on_delta: async (text) => {
                deadline_signal.throwIfAborted();
                if (typeof text !== "string")
                  throw new EngineError("PROTOCOL_ERROR");
                streamed += text;
                if (Buffer.byteLength(streamed) > 65536)
                  throw new EngineError("PROTOCOL_ERROR");
                if (text) await on_delta(text, deadline_signal);
              },
            })
          : await this.adapter.generate(request);
        if (on_delta && result.text !== streamed)
          throw new EngineError("PROTOCOL_ERROR");
        if (deadline_signal.aborted) throw new EngineError("CANCELLED");
        this.available();
        if (
          typeof result.text !== "string" ||
          !result.text.trim() ||
          Buffer.byteLength(result.text) > 64 * 1024
        )
          fail("INVALID_OUTPUT", 502);
        return {
          contract_version: 1,
          message: { role: "assistant", content: result.text },
        };
      },
      { signal: combined, timeout_ms: 175000 },
    );
    this.chat_active = { controller, task };
    try {
      return await task;
    } catch (error) {
      if (error instanceof InferenceError) throw error;
      const code =
        error instanceof EngineError ? error.code : "ENGINE_UNAVAILABLE";
      fail(
        code,
        code === "ENGINE_BUSY"
          ? 429
          : code === "CANCELLED"
            ? 409
            : code === "DEADLINE_EXCEEDED"
              ? 504
              : 503,
      );
    } finally {
      this.chat_active = null;
    }
  }
  async reference_chat(content, { signal, on_delta } = {}) {
    const question = content.trim().replace(/\s+/g, " ");
    if (
      question.length > 512 ||
      Buffer.byteLength(question) > 1024 ||
      /[\x00-\x1f]/.test(question)
    )
      fail("CHAT_REFERENCE_QUESTION", 400);
    if (!this.app_reference) fail("CHAT_REFERENCE_UNAVAILABLE", 503);
    if (this.reference_active.size >= 16) fail("ENGINE_BUSY", 429);
    const controller = new AbortController();
    const combined = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    let timed_out = false;
    const deadline = this.now() + 5000;
    const timeout = setTimeout(() => {
      timed_out = true;
      controller.abort();
    }, 5000);
    const entry = { controller, task: null };
    this.reference_active.add(entry);
    const task = (async () => {
      try {
        combined.throwIfAborted();
        const text = this.app_reference(question);
        if (this.now() >= deadline) {
          timed_out = true;
          controller.abort();
        }
        if (
          typeof text !== "string" ||
          !text.trim() ||
          Buffer.byteLength(text) > 65536
        )
          fail("CHAT_REFERENCE_UNAVAILABLE", 503);
        combined.throwIfAborted();
        if (on_delta) await on_delta(text, combined);
        if (this.now() >= deadline) {
          timed_out = true;
          controller.abort();
        }
        combined.throwIfAborted();
        this.available();
        return {
          contract_version: 1,
          message: { role: "assistant", content: text },
        };
      } catch (error) {
        if (combined.aborted)
          fail(
            timed_out ? "DEADLINE_EXCEEDED" : "CANCELLED",
            timed_out ? 504 : 409,
          );
        if (["INVALID_QUESTION", "INVALID_SKILL_INPUT"].includes(error.code))
          fail("CHAT_REFERENCE_QUESTION", 400);
        fail("CHAT_REFERENCE_UNAVAILABLE", 503);
      } finally {
        clearTimeout(timeout);
        this.reference_active.delete(entry);
      }
    })();
    entry.task = task;
    return task;
  }
  async submit(body, admission = {}) {
    this.available();
    const request = normalize_request(body);
    const fingerprint = hash(
      JSON.stringify({
        request: admission.delegation
          ? { ...request, deadline_ms: 0 }
          : request,
        engine: this.adapter.id,
        model: this.adapter.model,
        ...(admission.delegation ? { delegation: admission.delegation } : {}),
      }),
    );
    const existing = () => {
      const found = this.store.by_key(body.idempotency_key);
      if (
        admission.delegation &&
        !found &&
        this.store
          .all()
          .some(
            (job) =>
              job.delegation?.origin_node_id ===
                admission.delegation.origin_node_id &&
              job.delegation.origin_request_id ===
                admission.delegation.origin_request_id,
          )
      )
        fail("IDEMPOTENCY_CONFLICT", 409);
      if (found && found.fingerprint !== fingerprint)
        fail("IDEMPOTENCY_CONFLICT", 409);
      return found;
    };
    let prior = this.protect(existing);
    if (prior) return { job: public_job(prior), replayed: true };
    const status = await this.adapter.status();
    if (admission.delegation) {
      const expected = admission.delegation.expected;
      if (this.adapter.id !== expected.engine) fail("MODEL_MISMATCH", 409);
      let inventory;
      try {
        inventory = await this.adapter.list_models({ timeout_ms: 1000 });
      } catch {
        fail("ENGINE_UNAVAILABLE", 503);
      }
      const selected = inventory.find((item) => item.id === this.adapter.model);
      if (!selected) fail("MODEL_MISSING", 503);
      if (selected.digest !== expected.model_digest)
        fail("MODEL_MISMATCH", 409);
    }
    this.available();
    return this.protect(() => {
      // Recheck after metadata await: concurrent admissions cannot exceed bounds.
      if (admission.authorize && !admission.authorize())
        fail("SCOPE_DENIED", 403);
      prior = existing();
      if (prior) return { job: public_job(prior), replayed: true };
      this.store.maintain(this.now());
      if (
        this.store.all().filter((job) => job.state === "queued").length >=
        this.pending_limit
      )
        fail("QUEUE_FULL", 429);
      if (!["ready", "busy"].includes(status.state))
        fail(
          status.state === "model_missing"
            ? "MODEL_MISSING"
            : "ENGINE_UNAVAILABLE",
          503,
        );
      this.resources();
      const created_at = this.now();
      const deadline_at =
        admission.deadline_at ?? created_at + request.deadline_ms;
      if (deadline_at < created_at + 100) fail("DEADLINE_EXCEEDED", 408);
      const job = {
        id: randomUUID(),
        idempotency_key: body.idempotency_key,
        fingerprint,
        state: "queued",
        request,
        input_hash: this.store.artifact(request.input),
        result_hash: null,
        engine: this.adapter.id,
        model: this.adapter.model,
        created_at,
        deadline_at,
        started_at: null,
        finished_at: null,
        attempt_count: 0,
        error: null,
        provenance: null,
        ...(admission.delegation ? { delegation: admission.delegation } : {}),
      };
      this.store.insert(job);
      return { job: public_job(job), replayed: false };
    });
  }
  inspect(id, result = false) {
    this.available();
    return this.protect(() => {
      const job = this.store.get(id);
      if (!job) fail("NOT_FOUND", 404);
      if (!result) return public_job(job);
      if (job.state !== "completed") fail("RESULT_NOT_READY", 409);
      return this.store.read_artifact(job.result_hash);
    });
  }
  cancel(id) {
    this.available();
    return this.protect(() => {
      const job = this.store.get(id);
      if (!job) fail("NOT_FOUND", 404);
      if (!is_terminal(job.state)) {
        job.state = this.active?.id === id ? "cancelling" : "cancelled";
        job.error = "CANCELLED";
        if (job.state === "cancelled") job.finished_at = this.now();
        this.store.save(job); // Persist intent before touching the transport.
        if (this.active?.id === id) this.active.controller.abort();
      }
      return public_job(job);
    });
  }
  status() {
    this.available();
    return this.protect(() => ({
      contract_version: 1,
      concurrency: 1,
      pending_limit: this.pending_limit,
      queued: this.store.all().filter((job) => job.state === "queued").length,
      running: this.active || this.chat_active ? 1 : 0,
    }));
  }
  finish(job, state, error, finished_at = this.now()) {
    job.state = state;
    job.error = error;
    job.finished_at = finished_at;
    this.store.save(job);
  }
  tick() {
    if (this.stopping || this.broken) return;
    try {
      if (this.now() - this.last_maintenance >= 60000) {
        this.store.maintain(this.now());
        this.last_maintenance = this.now();
      }
      const queued = this.store.all().filter((job) => job.state === "queued");
      for (const job of queued)
        if (job.deadline_at <= this.now())
          this.finish(job, "expired", "DEADLINE_EXCEEDED");
      if (this.active || this.chat_active) return;
      const next = queued.find((job) => job.state === "queued");
      if (!next) return;
      // Pressure pauses dispatch; queued requests retain their original deadline.
      try {
        this.resources();
      } catch (error) {
        if (["MEMORY_PRESSURE", "DISK_PRESSURE"].includes(error.code)) return;
        throw error;
      }
      const controller = new AbortController();
      next.state = "running";
      next.started_at = this.now();
      next.attempt_count++;
      this.store.save(next);
      const task = this.execute(next, controller);
      this.active = { id: next.id, controller, task };
      task
        .finally(() => {
          this.active = null;
        })
        .catch(() => this.break_storage());
    } catch {
      this.break_storage();
    }
  }
  async execute(job, controller) {
    try {
      const result = await this.adapter.generate({
        messages: messages_for(job.request),
        schema,
        max_tokens: job.request.max_output_tokens,
        temperature: 0,
        timeout_ms: Math.max(1, job.deadline_at - this.now()),
        signal: controller.signal,
        ...(job.delegation
          ? { expected_model_digest: job.delegation.expected.model_digest }
          : {}),
      });
      if (this.broken) return;
      const current = this.store.get(job.id);
      if (current.state === "cancelling")
        return this.finish(current, "cancelled", "CANCELLED");
      if (this.stopping)
        return this.finish(current, "interrupted", "INTERRUPTED");
      if (this.now() >= job.deadline_at)
        return this.finish(current, "expired", "DEADLINE_EXCEEDED");
      if (
        job.delegation &&
        (result.engine !== job.delegation.expected.engine ||
          result.model_digest !== job.delegation.expected.model_digest)
      )
        throw new EngineError("MODEL_MISMATCH");
      const output = validate_output(result.structured);
      if (
        !ENGINE_IDS.includes(result.engine) ||
        typeof result.engine_version !== "string" ||
        !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.-]+)?$/.test(
          result.engine_version,
        ) ||
        !/^[a-f0-9]{64}$/.test(result.model_digest)
      )
        fail("INVALID_OUTPUT", 502);
      job.provenance = {
        engine: result.engine,
        engine_version: result.engine_version.split(/[-+]/)[0],
        model_digest: result.model_digest,
        template_version: 1,
        schema_version: 1,
        profile_version: 1,
        temperature: 0,
        max_output_tokens: job.request.max_output_tokens,
        context_tokens: 4096,
        cpu_threads: 2,
        usage: {
          input_tokens: number_or_null(result.usage?.input_tokens),
          output_tokens: number_or_null(result.usage?.output_tokens),
        },
        timings_ms: Object.fromEntries(
          ["total", "load", "input", "output"].map((key) => [
            key,
            number_or_null(result.timings_ms?.[key]),
          ]),
        ),
      };
      if (this.store.free_bytes() < this.min_disk_bytes)
        fail("DISK_PRESSURE", 503);
      job.result_hash = this.store.artifact({
        contract_version: 1,
        operation: job.request.operation,
        output,
        provenance: job.provenance,
      });
      const completed_at = this.now();
      if (completed_at >= job.deadline_at) {
        job.result_hash = null;
        this.finish(job, "expired", "DEADLINE_EXCEEDED", completed_at);
      } else this.finish(job, "completed", null, completed_at);
    } catch (error) {
      try {
        const current = this.store.get(job.id);
        if (current.state === "cancelling")
          this.finish(current, "cancelled", "CANCELLED");
        else if (this.stopping)
          this.finish(current, "interrupted", "INTERRUPTED");
        else if (error.code === "STORAGE_UNAVAILABLE") this.break_storage();
        else if (
          error instanceof EngineError ||
          error instanceof InferenceError
        ) {
          const code = error.code;
          this.finish(
            current,
            code === "DEADLINE_EXCEEDED" ? "expired" : "failed",
            code,
          );
        } else this.break_storage();
      } catch {
        this.break_storage();
      }
    }
  }
  async close() {
    this.stopping = true;
    clearInterval(this.timer);
    this.active?.controller.abort();
    this.chat_active?.controller.abort();
    for (const request of this.reference_active) request.controller.abort();
    await this.active?.task;
    await this.chat_active?.task?.catch(() => {});
    await Promise.allSettled(
      [...this.reference_active].map((request) => request.task),
    );
    this.store.close();
  }
}
