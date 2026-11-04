import path from "node:path";
import {
  load_identity,
  validate_identity,
  certificate_info,
} from "./identity.js";
import {
  load_trust,
  listener_settings,
  peer_directory,
} from "./configuration.js";
import { read_json } from "./files.js";
import { create_peer_server, tls_settings } from "./server.js";
import { probe_peer } from "./client.js";
import { ExchangeRuntime } from "../exchange/runtime.js";
import { DelegationRuntime } from "../delegation/runtime.js";

export class PeerRuntime {
  constructor({
    directory,
    settings,
    poll_ms = 5000,
    probe_interval_ms = 30000,
    source = () => null,
  }) {
    this.directory = directory;
    this.settings = settings;
    this.probe_interval_ms = probe_interval_ms;
    this.source = source;
    this.state = "starting";
    this.peers = [];
    this.observations = new Map();
    this.closed = false;
    this.timer = setInterval(() => this.tick(), poll_ms);
    this.timer.unref();
    this.tick();
  }
  status() {
    const eligible = this.peers.filter(
      (peer) => !peer.revoked && peer.outbound_scopes.includes("status:read"),
    );
    return {
      contract_version: 1,
      state: this.state,
      trusted_peers: this.peers.filter((peer) => !peer.revoked).length,
      revoked_peers: this.peers.filter((peer) => peer.revoked).length,
      reachable_peers: eligible.filter(
        (peer) => this.observations.get(peer.node_id)?.state === "reachable",
      ).length,
      unavailable_peers: eligible.filter(
        (peer) => this.observations.get(peer.node_id)?.state === "unavailable",
      ).length,
      certificate_expiring:
        Number.isFinite(this.expires_at) &&
        this.expires_at - Date.now() < 30 * 86400000,
      capabilities: {
        status: true,
        artifacts:
          !!this.exchange &&
          !this.exchange.store.failed &&
          !this.exchange.store.closed,
        delegation: !!this.delegation,
      },
      exchange: this.exchange?.status() || { state: "unavailable" },
      delegation: this.delegation?.status() || { state: "unavailable" },
    };
  }
  invalidate() {
    this.peers = [];
    this.observations.clear();
    this.probe?.controller.abort();
    this.delegation?.changed();
    this.transport?.disconnect();
    // Retain only our own certificate as a TLS trust anchor; no request is allowed.
    if (this.transport && this.identity)
      this.transport.server.setSecureContext(tls_settings(this.identity, []));
    this.signature = null;
  }
  async refresh() {
    const identity = this.identity
      ? validate_identity(
          read_json(path.join(this.directory, "identity.json"), 32768),
        )
      : await load_identity(this.directory);
    const trust = load_trust(this.directory, identity.node_id);
    const signature = JSON.stringify(identity) + trust.signature;
    if (this.closed) return;
    if (signature !== this.signature) {
      this.probe?.controller.abort();
      this.delegation?.changed();
      this.transport?.disconnect();
      this.identity = identity;
      this.expires_at = certificate_info(
        identity.certificate,
        identity.node_id,
      ).expires_at;
      this.peers = trust.peers;
      this.observations.clear();
      this.signature = signature;
      try {
        this.exchange?.update_peers(this.peers);
      } catch {
        /* Exchange failures do not affect peer status. */
      }
      this.transport?.server.setSecureContext(
        tls_settings(identity, this.peers),
      );
    }
    if (
      !this.exchange &&
      (!this.exchange_retry_at || this.exchange_retry_at <= Date.now())
    ) {
      try {
        this.exchange = new ExchangeRuntime({
          directory: path.join(this.directory, "exchange"),
          node_id: identity.node_id,
          source: this.source,
        });
        this.exchange.update_peers(this.peers);
      } catch {
        this.exchange_retry_at = Date.now() + 30000;
      }
    }
    if (
      !this.delegation &&
      (!this.delegation_retry_at || this.delegation_retry_at <= Date.now())
    ) {
      try {
        this.delegation = new DelegationRuntime({
          directory: path.join(this.directory, "delegation"),
          node_id: identity.node_id,
          source: this.source,
          identity: () => this.identity,
          peers: () => this.peers,
        });
      } catch {
        this.delegation_retry_at = Date.now() + 30000;
      }
    }
    try {
      this.exchange?.tick();
    } catch {
      /* Peer status remains available if the local source fails. */
    }
    if (!this.transport) {
      const transport = create_peer_server({
        identity,
        get_peers: () => this.peers,
        get_exchange: () => this.exchange?.store || null,
        get_delegation: () => this.delegation,
      });
      this.transport = transport;
      await new Promise((resolve, reject) => {
        transport.server.once("error", reject);
        transport.server.listen(this.settings.port, this.settings.host, () => {
          transport.server.removeListener("error", reject);
          resolve();
        });
      }).catch((error) => {
        transport.disconnect();
        transport.server.close();
        this.transport = null;
        throw error;
      });
      transport.server.on("error", () => {
        this.state = "unavailable";
        this.invalidate();
      });
    }
    this.state = "ready";
  }
  tick() {
    if (this.closed || this.refreshing) return;
    this.refreshing = this.refresh()
      .then(() => this.schedule_probe())
      .catch(() => {
        this.state = "unavailable";
        try {
          this.invalidate();
        } catch {
          /* Listener remains denied by empty application trust. */
        }
      })
      .finally(() => {
        this.refreshing = null;
      });
  }
  schedule_probe() {
    if (this.closed || this.probe || this.state !== "ready") return;
    const peer = this.peers
      .filter(
        (entry) =>
          !entry.revoked &&
          entry.outbound_scopes.includes("status:read") &&
          (this.observations.get(entry.node_id)?.next_at || 0) <= Date.now(),
      )
      .sort(
        (a, b) =>
          (this.observations.get(a.node_id)?.next_at || 0) -
          (this.observations.get(b.node_id)?.next_at || 0),
      )[0];
    const sharing = this.exchange?.next_peer(this.peers);
    if (
      sharing &&
      (!peer ||
        this.exchange.due_at(sharing) <
          (this.observations.get(peer.node_id)?.next_at || 0))
    ) {
      const controller = new AbortController();
      const task = this.exchange
        .sync(this.identity, sharing, controller.signal)
        .finally(() => {
          if (this.probe?.controller === controller) this.probe = null;
        });
      this.probe = { controller, task };
      return;
    }
    if (!peer) return;
    const controller = new AbortController();
    const observation = this.observations.get(peer.node_id) || { failures: 0 };
    const task = probe_peer({
      identity: this.identity,
      peer,
      signal: controller.signal,
    })
      .then(() => {
        if (!controller.signal.aborted)
          this.observations.set(peer.node_id, {
            state: "reachable",
            failures: 0,
            next_at: Date.now() + this.probe_interval_ms,
          });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          this.observations.set(peer.node_id, {
            state: "unavailable",
            failures: observation.failures + 1,
            next_at:
              Date.now() +
              Math.min(
                300000,
                this.probe_interval_ms * 2 ** Math.min(observation.failures, 4),
              ),
          });
      })
      .finally(() => {
        if (this.probe?.controller === controller) this.probe = null;
      });
    this.probe = { controller, task };
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    this.probe?.controller.abort();
    await this.refreshing;
    await this.probe?.task;
    await this.delegation?.close();
    await this.exchange?.close();
    if (this.transport) {
      this.transport.disconnect();
      await new Promise((resolve) => this.transport.server.close(resolve));
    }
  }
}
export const create_peer_runtime = (
  environment = process.env,
  options = {},
) => {
  if (environment.FRACTO_AI_PEERS_ENABLED === "false")
    return {
      status: () => ({ contract_version: 1, state: "disabled" }),
      close: async () => {},
    };
  try {
    if (
      environment.FRACTO_AI_PEERS_ENABLED &&
      environment.FRACTO_AI_PEERS_ENABLED !== "true"
    )
      throw new Error();
    return new PeerRuntime({
      directory: peer_directory(environment),
      settings: listener_settings(environment),
      ...options,
    });
  } catch {
    return {
      status: () => ({ contract_version: 1, state: "unavailable" }),
      close: async () => {},
    };
  }
};
