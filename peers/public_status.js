const count = (value) =>
  Number.isInteger(value) && value >= 0 && value <= 16 ? value : 0;
export const public_peer_status = (value = {}) => ({
  contract_version: 1,
  state: ["starting", "disabled", "ready", "unavailable"].includes(value.state)
    ? value.state
    : "unavailable",
  trusted_peers: count(value.trusted_peers),
  revoked_peers: count(value.revoked_peers),
  reachable_peers: count(value.reachable_peers),
  unavailable_peers: count(value.unavailable_peers),
  certificate_expiring: value.certificate_expiring === true,
  capabilities: {
    status: true,
    artifacts: value.capabilities?.artifacts === true,
    delegation: value.capabilities?.delegation === true,
  },
  delegation: {
    state: value.delegation?.state === "ready" ? "ready" : "unavailable",
    pending: count(value.delegation?.pending),
    unknown:
      Number.isInteger(value.delegation?.unknown) &&
      value.delegation.unknown >= 0 &&
      value.delegation.unknown <= 1100
        ? value.delegation.unknown
        : 0,
    completed:
      Number.isInteger(value.delegation?.completed) &&
      value.delegation.completed >= 0 &&
      value.delegation.completed <= 1100
        ? value.delegation.completed
        : 0,
  },
  exchange: {
    state: value.exchange?.state === "ready" ? "ready" : "unavailable",
    local_records:
      Number.isInteger(value.exchange?.local_records) &&
      value.exchange.local_records >= 0 &&
      value.exchange.local_records <= 1100
        ? value.exchange.local_records
        : 0,
    imported_records:
      Number.isInteger(value.exchange?.imported_records) &&
      value.exchange.imported_records >= 0 &&
      value.exchange.imported_records <= 1100
        ? value.exchange.imported_records
        : 0,
    quarantined_records:
      Number.isInteger(value.exchange?.quarantined_records) &&
      value.exchange.quarantined_records >= 0 &&
      value.exchange.quarantined_records <= 100
        ? value.exchange.quarantined_records
        : 0,
    synced_peers: count(value.exchange?.synced_peers),
    pending_peers: count(value.exchange?.pending_peers),
    unavailable_peers: count(value.exchange?.unavailable_peers),
    local_source:
      value.exchange?.local_source === "ready" ? "ready" : "unavailable",
  },
});
