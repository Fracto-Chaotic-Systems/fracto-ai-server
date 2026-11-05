import { peer_request } from "../peers/client.js";
import { DistributionError, fail, page_contract, encode } from "./contracts.js";

export const synchronize_distribution = async ({
  store,
  identity,
  peer,
  kind,
  signal,
  request = peer_request,
}) => {
  const deadline = new AbortController(),
    combined = signal
      ? AbortSignal.any([signal, deadline.signal])
      : deadline.signal;
  const timer = setTimeout(() => deadline.abort(), 30000);
  const base = `/peer/v1/distribution/${kind}`;
  try {
    const cursor = store.cursor(peer.node_id, kind);
    let page;
    try {
      const response = await request({
        identity,
        peer,
        route: `${base}/manifest/${cursor.epoch}/${cursor.cursor}`,
        signal: combined,
      });
      page = page_contract(response.value, kind, cursor.cursor);
      if (cursor.epoch !== "start" && cursor.epoch !== page.epoch)
        fail("INVALID_DISTRIBUTION_MANIFEST");
    } catch (error) {
      if (error instanceof DistributionError)
        store.quarantine(peer.node_id, "INVALID_DISTRIBUTION_MANIFEST");
      throw error;
    }
    for (const entry of page.entries) {
      if (combined.aborted) fail("DISTRIBUTION_CANCELLED", 503);
      const disposition = store.disposition(entry);
      if (disposition === "conflict")
        store.quarantine(peer.node_id, "ORIGIN_CONFLICT");
      if (disposition === "missing") {
        try {
          const response = await request({
            identity,
            peer,
            route: `${base}/blob/${entry.digest}`,
            signal: combined,
          });
          if (combined.aborted) fail("DISTRIBUTION_CANCELLED", 503);
          store.import(peer.node_id, kind, entry, response.bytes);
        } catch (error) {
          if (
            !(error instanceof DistributionError) ||
            ![
              "INVALID_DISTRIBUTION",
              "HASH_MISMATCH",
              "ORIGIN_CONFLICT",
            ].includes(error.code)
          )
            throw error;
          store.quarantine(peer.node_id, error.code);
        }
      } else if (disposition === "known") {
        const known = store.get(entry.digest).record;
        if (known.kind !== kind || encode(known).length !== entry.bytes)
          store.quarantine(peer.node_id, "INVALID_DISTRIBUTION");
      }
      store.checkpoint(peer.node_id, kind, page.epoch, entry.sequence);
    }
    if (!page.entries.length)
      store.checkpoint(peer.node_id, kind, page.epoch, page.next_cursor);
    return { has_more: page.has_more };
  } catch (error) {
    if (error.code === "RESNAPSHOT_REQUIRED") {
      store.reset(peer.node_id, kind);
      return { reset: true };
    }
    if (error.code === "PEER_PROTOCOL_ERROR")
      store.quarantine(peer.node_id, error.code);
    throw error;
  } finally {
    clearTimeout(timer);
  }
};
