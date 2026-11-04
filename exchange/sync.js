import { peer_request } from "../peers/client.js";
import { ArtifactError, deny, manifest_contract } from "./contracts.js";
import { metadata_contract } from "./metadata.js";

/** Durable checkpoint per entry; partial pages retry without duplicating records. */
export const synchronize = async ({
  store,
  identity,
  peer,
  signal,
  request = peer_request,
}) => {
  const deadline = new AbortController();
  const combined = signal
    ? AbortSignal.any([signal, deadline.signal])
    : deadline.signal;
  const timer = setTimeout(() => deadline.abort(), 30000);
  const get = (route) => request({ identity, peer, route, signal: combined });
  try {
    const metadata = await get("/peer/v1/artifacts/metadata");
    let inventory;
    try {
      inventory = metadata_contract(metadata.value);
    } catch {
      throw new ArtifactError("INVALID_METADATA");
    }
    store.save_metadata(peer.node_id, inventory);
    const checkpoint = store.cursor(peer.node_id);
    const response = await get(
      `/peer/v1/artifacts/manifest/${checkpoint.epoch}/${checkpoint.cursor}`,
    );
    let page;
    try {
      page = manifest_contract(response.value, checkpoint.cursor);
      if (checkpoint.epoch !== "start" && checkpoint.epoch !== page.epoch)
        deny("INVALID_MANIFEST");
    } catch {
      store.quarantine(peer.node_id, "INVALID_MANIFEST");
      throw new ArtifactError("INVALID_MANIFEST");
    }
    for (const entry of page.entries) {
      if (combined.aborted) deny("SYNC_CANCELLED", 503);
      const state = store.disposition(entry);
      if (state === "conflict")
        store.quarantine(peer.node_id, "ORIGIN_CONFLICT");
      if (state !== "missing") {
        store.checkpoint(peer.node_id, page.epoch, entry.sequence);
        continue;
      }
      try {
        const blob = await get(`/peer/v1/artifacts/blob/${entry.digest}`);
        if (combined.aborted) deny("SYNC_CANCELLED", 503);
        store.import(peer.node_id, entry, blob.bytes, page.epoch);
      } catch (error) {
        const rejected =
          error instanceof ArtifactError &&
          ["INVALID_ARTIFACT", "HASH_MISMATCH", "ORIGIN_CONFLICT"].includes(
            error.code,
          );
        if (!rejected && error.code !== "PEER_PROTOCOL_ERROR") throw error;
        store.quarantine(peer.node_id, error.code);
        store.checkpoint(peer.node_id, page.epoch, entry.sequence);
      }
    }
    if (!page.entries.length)
      store.checkpoint(peer.node_id, page.epoch, page.next_cursor);
    store.maintain();
    return { has_more: page.has_more };
  } catch (error) {
    if (error.code === "RESNAPSHOT_REQUIRED") {
      store.reset_cursor(peer.node_id);
      return { reset: true };
    }
    if (error.code === "INVALID_METADATA")
      store.quarantine(peer.node_id, "INVALID_METADATA");
    if (error.code === "PEER_PROTOCOL_ERROR")
      store.quarantine(peer.node_id, "PEER_PROTOCOL_ERROR");
    throw error;
  } finally {
    clearTimeout(timer);
  }
};
