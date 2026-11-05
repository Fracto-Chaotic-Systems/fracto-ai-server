import { DistributionStore } from "./storage.js";
import { kinds } from "./contracts.js";
import { synchronize_distribution } from "./sync.js";

export class DistributionRuntime {
  constructor(directory, node_id) {
    this.store = new DistributionStore(directory, node_id);
    this.states = new Map();
  }
  update_peers(peers) {
    this.store.retain(
      new Set(
        peers.filter((peer) => !peer.revoked).map((peer) => peer.node_id),
      ),
    );
    this.states.clear();
  }
  next(peers) {
    return peers
      .filter((peer) => !peer.revoked)
      .flatMap((peer) =>
        Object.entries(kinds)
          .filter(([, scope]) => peer.outbound_scopes.includes(scope))
          .map(([kind]) => ({
            peer,
            kind,
            at: this.states.get(`${peer.node_id}:${kind}`)?.at ?? 0,
          })),
      )
      .filter((item) => item.at <= Date.now())
      .sort((a, b) => a.at - b.at)[0];
  }
  async sync(identity, item, signal) {
    const key = `${item.peer.node_id}:${item.kind}`,
      failures = this.states.get(key)?.failures ?? 0;
    try {
      await synchronize_distribution({
        store: this.store,
        identity,
        peer: item.peer,
        kind: item.kind,
        signal,
      });
      if (!signal.aborted)
        this.states.set(key, { at: Date.now() + 30000, failures: 0 });
    } catch {
      if (!signal.aborted)
        this.states.set(key, {
          at: Date.now() + Math.min(300000, 30000 * 2 ** Math.min(failures, 4)),
          failures: failures + 1,
        });
    }
  }
  close() {
    this.store.close();
  }
}
