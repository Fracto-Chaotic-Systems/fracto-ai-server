import { uuid } from "../inference/contracts.js";
import { ENGINE_IDS } from "../engines/contracts.js";
import { digest_id, result_contract } from "../exchange/contracts.js";
import {
  error_code,
  fail,
  receiver_key,
  request_hash,
  wire_request,
} from "./contracts.js";

export class DelegationReceiver {
  constructor({ node_id, source, authorize = () => true }) {
    this.node_id = node_id;
    this.source = source;
    this.authorize = authorize;
  }
  service() {
    const service = this.source();
    if (!service) fail("INFERENCE_UNAVAILABLE", 503);
    service.available();
    return service;
  }
  async capabilities() {
    let engine = null,
      model_digest = null,
      available = false;
    try {
      const service = this.service();
      engine = ENGINE_IDS.includes(service.adapter.id)
        ? service.adapter.id
        : null;
      const [status, models] = await Promise.all([
        service.adapter.status(),
        service.adapter.list_models({ timeout_ms: 1000 }),
      ]);
      const selected = models.find((item) => item.id === service.adapter.model);
      if (digest_id(selected?.digest)) model_digest = selected.digest;
      available =
        !!engine && !!model_digest && ["ready", "busy"].includes(status.state);
    } catch {
      /* Read-only availability never exposes engine error details. */
    }
    return {
      contract_version: 1,
      executor_node_id: this.node_id,
      available,
      engine,
      model_digest,
      profile_version: 1,
    };
  }
  find(sender, id) {
    if (!this.authorize(sender)) fail("SCOPE_DENIED", 403);
    if (!uuid(sender) || !uuid(id)) fail();
    const service = this.service();
    const job = service.protect(() =>
      service.store
        .all()
        .find(
          (row) =>
            row.delegation?.origin_node_id === sender &&
            row.delegation.origin_request_id === id,
        ),
    );
    if (!job) fail("DELEGATION_NOT_FOUND", 404);
    return { service, job };
  }
  snapshot(service, job) {
    const d = job.delegation;
    let result = null;
    if (job.state === "completed")
      result = result_contract(service.inspect(job.id, true));
    return {
      contract_version: 1,
      origin_node_id: d.origin_node_id,
      origin_request_id: d.origin_request_id,
      executor_node_id: this.node_id,
      request_hash: d.request_hash,
      deadline_at: job.deadline_at,
      state: job.state,
      created_at: job.created_at,
      started_at: job.started_at,
      finished_at: job.finished_at,
      attempt_count: job.attempt_count,
      error: job.error === null ? null : error_code({ code: job.error }),
      result,
    };
  }
  async accept(sender, input) {
    if (!this.authorize(sender)) fail("SCOPE_DENIED", 403);
    const wire = wire_request(input, sender);
    const service = this.service();
    const key = receiver_key(sender, wire.origin_idempotency_key);
    const fingerprint = request_hash(wire);
    const existing = service.protect(() => service.store.by_key(key));
    if (existing) {
      if (
        existing.delegation?.request_hash !== fingerprint ||
        existing.delegation?.origin_request_id !== wire.origin_request_id
      )
        fail("IDEMPOTENCY_CONFLICT", 409);
      return { status: 200, value: this.snapshot(service, existing) };
    }
    const now = Date.now();
    if (wire.deadline_at <= now + 100) fail("DEADLINE_EXCEEDED", 408);
    if (
      Math.abs(wire.deadline_at - now - wire.remaining_ms) > 5000 ||
      wire.created_at > now + 5000
    )
      fail("CLOCK_SKEW", 409);
    const remaining = Math.min(wire.remaining_ms, wire.deadline_at - now);
    if (remaining < 100) fail("DEADLINE_EXCEEDED", 408);
    const delegation = {
      origin_node_id: sender,
      origin_request_id: wire.origin_request_id,
      origin_idempotency_key: wire.origin_idempotency_key,
      origin_deadline_at: wire.deadline_at,
      expected: wire.expected,
      request_hash: fingerprint,
      hop_count: 1,
    };
    const accepted = await service.submit(
      {
        contract_version: 1,
        idempotency_key: key,
        operation: wire.request.operation,
        input: wire.request.input,
        max_output_tokens: wire.request.max_output_tokens,
        deadline_ms: remaining,
      },
      {
        delegation,
        deadline_at: Math.min(wire.deadline_at, now + remaining),
        authorize: () => this.authorize(sender),
      },
    );
    const job = service.protect(() =>
      service.store.get(accepted.job.request_id),
    );
    return {
      status: accepted.replayed ? 200 : 202,
      value: this.snapshot(service, job),
    };
  }
  inspect(sender, id) {
    const { service, job } = this.find(sender, id);
    return this.snapshot(service, job);
  }
  cancel(sender, id) {
    const { service, job } = this.find(sender, id);
    service.cancel(job.id);
    return this.snapshot(service, service.store.get(job.id));
  }
}
