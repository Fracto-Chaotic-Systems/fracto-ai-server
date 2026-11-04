import { ExchangeStore } from "./storage.js";
import { collect_local } from "./local.js";
import { collect_metadata } from "./metadata.js";
import { synchronize } from "./sync.js";

/** One catalog per logical installation, independent of the inference database. */
export class ExchangeRuntime {
  constructor({ directory, node_id, source = () => null }) {
    this.store = new ExchangeStore(directory, node_id);
    this.source = source;
    this.states = new Map();
    this.local_state = "unavailable";
    this.metadata_at = 0;
  }
  tick() {
    if (this.store.failed || this.store.closed) return;
    try {
      this.local_state = collect_local(this.store, this.source());
      this.store.maintain();
    } catch {
      this.local_state = "unavailable";
    }
    if (!this.inventory && Date.now() - this.metadata_at >= 60000) {
      const controller = new AbortController();
      const task = collect_metadata(this.source()?.adapter, controller.signal)
        .then((metadata) => {
          if (!controller.signal.aborted) {
            this.store.inventory = metadata;
            this.metadata_at = Date.now();
          }
        })
        .catch(() => {})
        .finally(() => {
          this.inventory = null;
        });
      this.inventory = { controller, task };
    }
  }
  update_peers(peers) {
    this.store.retain_peers(new Set(peers.map((peer) => peer.node_id)));
    this.states.clear();
    for (const peer of peers)
      if (!peer.revoked && peer.outbound_scopes.includes("artifacts:exchange"))
        this.states.set(peer.node_id, {
          state: "pending",
          failures: 0,
          next_at: 0,
        });
  }
  next_peer(peers) {
    if (this.store.failed || this.store.closed) return null;
    return peers
      .filter(
        (peer) =>
          !peer.revoked &&
          peer.outbound_scopes.includes("artifacts:exchange") &&
          this.due_at(peer) <= Date.now(),
      )
      .sort((a, b) => this.due_at(a) - this.due_at(b))[0];
  }
  due_at(peer) {
    return this.states.get(peer.node_id)?.next_at || 0;
  }
  async sync(identity, peer, signal) {
    const failures = this.states.get(peer.node_id)?.failures || 0;
    try {
      const progress = await synchronize({
        store: this.store,
        identity,
        peer,
        signal,
      });
      if (!signal.aborted)
        this.states.set(peer.node_id, {
          state: progress.has_more || progress.reset ? "catching_up" : "synced",
          failures: 0,
          next_at: Date.now() + 30000,
        });
    } catch {
      if (!signal.aborted)
        this.states.set(peer.node_id, {
          state: "unavailable",
          failures: failures + 1,
          next_at:
            Date.now() + Math.min(300000, 30000 * 2 ** Math.min(failures, 4)),
        });
    }
  }
  status() {
    try {
      return {
        ...this.store.status(),
        local_source: this.local_state,
        synced_peers: [...this.states.values()].filter(
          (state) => state.state === "synced",
        ).length,
        pending_peers: [...this.states.values()].filter((state) =>
          ["pending", "catching_up"].includes(state.state),
        ).length,
        unavailable_peers: [...this.states.values()].filter(
          (state) => state.state === "unavailable",
        ).length,
      };
    } catch {
      return { state: "unavailable" };
    }
  }
  async close() {
    this.inventory?.controller.abort();
    await this.inventory?.task;
    this.store.close();
  }
}
