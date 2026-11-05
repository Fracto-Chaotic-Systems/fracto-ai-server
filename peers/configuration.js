import fs from "node:fs";
import path from "node:path";
import { isIP } from "node:net";
import { fields, certificate_info } from "./identity.js";
import { read_json, reject, write_json } from "./files.js";
import { uuid } from "../inference/contracts.js";

export const SCOPES = Object.freeze([
  "status:read",
  "artifacts:exchange",
  "inference:delegate",
  "knowledge:exchange",
  "skills:exchange",
]);
export const endpoint_url = (value) => {
  if (typeof value !== "string" || value.length > 512) reject();
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !url.hostname ||
    !url.port ||
    url.port === "11434"
  )
    reject();
  return url;
};
export const validate_trust = (
  document,
  own_id,
  { allow_expired = false } = {},
) => {
  fields(document, ["contract_version", "peers"]);
  if (
    document.contract_version !== 1 ||
    !Array.isArray(document.peers) ||
    document.peers.length > 16
  )
    reject();
  const ids = new Set();
  const fingerprints = new Set();
  return document.peers.map((peer) => {
    fields(peer, [
      "node_id",
      "certificate",
      "endpoint",
      "inbound_scopes",
      "outbound_scopes",
      "revoked",
    ]);
    if (
      !uuid(peer.node_id) ||
      peer.node_id === own_id ||
      ids.has(peer.node_id) ||
      typeof peer.revoked !== "boolean"
    )
      reject();
    const info = certificate_info(
      peer.certificate,
      peer.node_id,
      Date.now(),
      peer.revoked || allow_expired,
    );
    if (fingerprints.has(info.fingerprint)) reject();
    for (const direction of ["inbound_scopes", "outbound_scopes"]) {
      if (
        !Array.isArray(peer[direction]) ||
        peer[direction].length > SCOPES.length ||
        new Set(peer[direction]).size !== peer[direction].length ||
        peer[direction].some((scope) => !SCOPES.includes(scope))
      )
        reject();
    }
    endpoint_url(peer.endpoint);
    ids.add(peer.node_id);
    fingerprints.add(info.fingerprint);
    return {
      ...peer,
      fingerprint: info.fingerprint,
      expires_at: info.expires_at,
    };
  });
};
export const load_trust = (directory, own_id) => {
  const filename = path.join(directory, "trust.json");
  if (!fs.existsSync(filename)) {
    try {
      write_json(
        filename,
        { contract_version: 1, peers: [] },
        { initial: true },
      );
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  const document = read_json(filename);
  return {
    document,
    peers: validate_trust(document, own_id),
    signature: JSON.stringify(document),
  };
};
export const peer_directory = (environment = process.env) => {
  // A Windows-backed source mount can report POSIX 0700 while Windows ACLs still
  // allow broader reads. Containers must use explicitly configured private data.
  if (
    fs.existsSync("/.dockerenv") &&
    !environment.FRACTO_AI_PEER_DATA_DIR &&
    !environment.FRACTO_AI_DATA_DIR
  )
    reject();
  return path.resolve(
    environment.FRACTO_AI_PEER_DATA_DIR ||
      (environment.FRACTO_AI_DATA_DIR
        ? path.join(environment.FRACTO_AI_DATA_DIR, "peers")
        : path.join(import.meta.dirname, "../runtime/peers")),
  );
};
export const listener_settings = (environment = process.env) => {
  const host = environment.FRACTO_AI_PEER_LISTEN_HOST || "127.0.0.1";
  const port = environment.FRACTO_AI_PEER_PORT || "3447";
  if (
    !isIP(host) ||
    !/^\d+$/.test(port) ||
    Number(port) < 1 ||
    Number(port) > 65535 ||
    [3007, 3107, 11434].includes(Number(port))
  )
    reject();
  return { host, port: Number(port) };
};
