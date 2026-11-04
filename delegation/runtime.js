import { randomUUID } from "node:crypto";
import { hash } from "../inference/contracts.js";
import { peer_request } from "../peers/client.js";
import { digest_id, exact } from "../exchange/contracts.js";
import { ENGINE_IDS } from "../engines/contracts.js";
import { DelegationStore, active } from "./storage.js";
import { DelegationReceiver } from "./receiver.js";
import {
  error_code,
  DelegationError,
  fail,
  local_request,
  public_receipt,
  receipt_contract,
  request_hash,
  wire_request,
} from "./contracts.js";
import { perform } from "./outbound.js";

export class DelegationRuntime {
  constructor({
    directory,
    node_id,
    source,
    identity,
    peers,
    poll_ms = 500,
    query_interval_ms = 5000,
    min_peer_interval_ms = 1000,
    request = peer_request,
  }) {
    this.store = new DelegationStore(directory, node_id);
    this.node_id = node_id;
    this.identity = identity;
    this.peers = peers;
    this.request = request;
    this.query_interval_ms = query_interval_ms;
    this.min_peer_interval_ms = min_peer_interval_ms;
    this.receiver = new DelegationReceiver({
      node_id,
      source,
      authorize: (sender) =>
        this.peers().some(
          (peer) =>
            peer.node_id === sender &&
            !peer.revoked &&
            peer.inbound_scopes.includes("inference:delegate"),
        ),
    });
    this.next_peer_at = new Map();
    this.closed = false;
    this.timer = setInterval(() => this.tick(), poll_ms);
    this.timer.unref();
  }
  allowed(peer_id) {
    const peer = this.peers().find(
      (entry) =>
        entry.node_id === peer_id &&
        !entry.revoked &&
        entry.outbound_scopes.includes("inference:delegate"),
    );
    if (!peer) fail("PEER_NOT_ALLOWED", 403);
    return peer;
  }
  submit(body) {
    const normalized = local_request(body);
    const fingerprint = hash(JSON.stringify(normalized));
    const prior = this.store.by_key(normalized.idempotency_key);
    if (prior) {
      if (prior.fingerprint !== fingerprint) fail("IDEMPOTENCY_CONFLICT", 409);
      return { ...public_receipt(prior), replayed: true };
    }
    this.allowed(normalized.peer_id);
    this.store.maintain();
    this.store.capacity();
    const created_at = Date.now();
    const row = {
      id: randomUUID(),
      origin_node_id: this.node_id,
      idempotency_key: normalized.idempotency_key,
      fingerprint,
      peer_id: normalized.peer_id,
      expected: normalized.expected,
      request: normalized.request,
      state: "prepared",
      created_at,
      deadline_at: created_at + normalized.request.deadline_ms,
      finished_at: null,
      error: null,
      receipt: null,
      reconciling: false,
      cancel_requested: false,
      next_at: 0,
    };
    const wire = wire_request(
      {
        contract_version: 1,
        origin_node_id: this.node_id,
        origin_request_id: row.id,
        origin_idempotency_key: row.idempotency_key,
        hop_count: 1,
        created_at,
        deadline_at: row.deadline_at,
        remaining_ms: row.request.deadline_ms,
        expected: row.expected,
        request: {
          operation: row.request.operation,
          input: row.request.input,
          max_output_tokens: row.request.max_output_tokens,
        },
      },
      this.node_id,
    );
    row.request_hash = request_hash(wire);
    this.store.insert(row);
    return { ...public_receipt(row), replayed: false };
  }
  inspect(id, result = false) {
    const row = this.store.get(id);
    if (!row) fail("DELEGATION_NOT_FOUND", 404);
    if (!result) return public_receipt(row);
    if (row.state !== "completed") fail("OUTCOME_UNKNOWN", 409);
    return {
      contract_version: 1,
      trust: "untrusted_evidence",
      origin_node_id: row.origin_node_id,
      origin_request_id: row.id,
      executor_node_id: row.peer_id,
      result: receipt_contract(row.receipt, row, row.peer_id).result,
    };
  }
  cancel(id) {
    const row = this.store.get(id);
    if (!row) fail("DELEGATION_NOT_FOUND", 404);
    if (active(row)) {
      row.cancel_requested = true;
      if (row.state === "prepared") {
        row.state = "cancelled";
        row.finished_at = Date.now();
        row.error = "CANCELLED";
        row.reconciling = false;
      } else {
        row.reconciling = true;
        row.next_at = 0;
      }
      this.store.save(row);
    }
    return public_receipt(row);
  }
  tick() {
    if (this.closed || this.store.failed || this.active || this.reading_profile)
      return;
    try {
      const now = Date.now();
      const rows = this.store.all();
      for (const row of rows) {
        if (row.state === "prepared" && row.deadline_at <= now) {
          row.state = "expired";
          row.error = "DEADLINE_EXCEEDED";
          row.finished_at = now;
          this.store.save(row);
        } else if (active(row) && row.deadline_at + 300000 <= now) {
          row.state = "unknown";
          row.error = "RECONCILIATION_EXPIRED";
          row.reconciling = false;
          row.finished_at = now;
          this.store.save(row);
        }
      }
      const known = new Set(this.peers().map((peer) => peer.node_id));
      for (const id of this.next_peer_at.keys())
        if (!known.has(id)) this.next_peer_at.delete(id);
      const row = rows
        .filter(
          (entry) =>
            active(entry) &&
            entry.next_at <= now &&
            (this.next_peer_at.get(entry.peer_id) || 0) <= now,
        )
        .sort(
          (a, b) => a.next_at - b.next_at || a.deadline_at - b.deadline_at,
        )[0];
      if (!row) {
        this.store.maintain();
        return;
      }
      this.next_peer_at.set(row.peer_id, now + this.min_peer_interval_ms);
      const controller = new AbortController();
      const task = perform(this, row, controller.signal)
        .catch(() => {})
        .finally(() => {
          this.active = null;
        });
      this.active = { controller, task };
    } catch {
      /* Failed storage stops new delegation without affecting local work. */
    }
  }
  changed() {
    this.active?.controller.abort();
    this.reading_profile?.abort();
  }
  async capabilities(peer_id) {
    const peer = this.allowed(peer_id);
    if (this.active || this.reading_profile) fail("PEER_BUSY", 429);
    const controller = new AbortController();
    this.reading_profile = controller;
    try {
      const response = await this.request({
        identity: this.identity(),
        peer,
        route: "/peer/v1/delegations/capabilities",
        signal: controller.signal,
      });
      const value = response.value;
      if (response.status !== undefined && response.status !== 200)
        fail(
          error_code({ code: value?.error }),
          response.status === 403 ? 403 : 503,
        );
      exact(value, [
        "contract_version",
        "executor_node_id",
        "available",
        "engine",
        "model_digest",
        "profile_version",
      ]);
      if (
        value.contract_version !== 1 ||
        value.executor_node_id !== peer_id ||
        typeof value.available !== "boolean" ||
        !(value.engine === null || ENGINE_IDS.includes(value.engine)) ||
        !(value.model_digest === null || digest_id(value.model_digest)) ||
        value.profile_version !== 1 ||
        (value.available && (!value.engine || !value.model_digest))
      )
        fail("INVALID_RECEIPT", 502);
      return {
        contract_version: 1,
        executor_node_id: peer_id,
        available: value.available,
        engine: value.engine,
        model_digest: value.model_digest,
        profile_version: 1,
      };
    } catch (error) {
      fail(
        error_code(error),
        error instanceof DelegationError ? error.status : 503,
      );
    } finally {
      this.reading_profile = null;
    }
  }
  status() {
    try {
      const rows = this.store.all();
      return {
        state: "ready",
        pending: rows.filter(active).length,
        unknown: rows.filter((row) => row.state === "unknown").length,
        completed: rows.filter((row) => row.state === "completed").length,
      };
    } catch {
      return { state: "unavailable" };
    }
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    this.changed();
    await this.active?.task;
    this.store.close();
  }
}
