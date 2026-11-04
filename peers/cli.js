import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  certificate_info,
  fields,
  generate_identity,
  load_identity,
  public_identity,
} from "./identity.js";
import { load_trust, peer_directory, validate_trust } from "./configuration.js";
import { read_json, reject, write_json } from "./files.js";

/** Local filesystem administration only. No enrollment or path-reading HTTP API. */
export const run_peer_command = async (args, directory = peer_directory()) => {
  const command = args[0];
  const identity = await load_identity(directory, {
    allow_expired: command === "rotate",
  });
  if (command === "status" && args.length === 1) {
    const trust = load_trust(directory, identity.node_id);
    const info = certificate_info(identity.certificate, identity.node_id);
    return {
      contract_version: 1,
      node_id: identity.node_id,
      certificate_fingerprint: info.fingerprint,
      expires_at: info.expires_at,
      trusted_peers: trust.peers.filter((peer) => !peer.revoked).length,
      revoked_peers: trust.peers.filter((peer) => peer.revoked).length,
    };
  }
  const lock = path.join(directory, "admin.lock");
  const fd = fs.openSync(lock, "wx", 0o600);
  try {
    if (command === "rotate" && args.length === 1) {
      const next = await generate_identity(identity.node_id);
      write_json(path.join(directory, "identity.json"), next);
      write_json(
        path.join(directory, "enrollment.json"),
        public_identity(next),
      );
      return { contract_version: 1, status: "rotated" };
    }
    // Read the existing document without validating active expiry so that revoke
    // can recover a trust file containing an expired peer certificate.
    const filename = path.join(directory, "trust.json");
    if (!fs.existsSync(filename)) load_trust(directory, identity.node_id);
    const document = read_json(filename);
    fields(document, ["contract_version", "peers"]);
    if (document.contract_version !== 1 || !Array.isArray(document.peers))
      reject();
    if (command === "enroll" && [4, 6].includes(args.length)) {
      const bundle = read_json(path.resolve(args[1]), 16384);
      fields(bundle, ["contract_version", "node_id", "certificate"]);
      if (bundle.contract_version !== 1) reject();
      const info = certificate_info(bundle.certificate, bundle.node_id);
      if (args[3].toUpperCase() !== info.fingerprint) reject();
      const scopes = (value) => (value === "-" ? [] : value.split(","));
      const entry = {
        node_id: bundle.node_id,
        certificate: bundle.certificate,
        endpoint: args[2],
        inbound_scopes: scopes(args[4] ?? "status:read"),
        outbound_scopes: scopes(args[5] ?? "status:read"),
        revoked: false,
      };
      document.peers = document.peers
        .filter((peer) => peer.node_id !== bundle.node_id)
        .concat(entry);
    } else if (["revoke", "forget"].includes(command) && args.length === 2) {
      const found = document.peers.find((peer) => peer.node_id === args[1]);
      if (!found) reject();
      if (command === "revoke") found.revoked = true;
      else document.peers = document.peers.filter((peer) => peer !== found);
    } else reject();
    // Permit repairing several expired entries one at a time. Runtime loading
    // remains strict and denies the document until all active expiry is resolved.
    validate_trust(document, identity.node_id, { allow_expired: true });
    write_json(filename, document);
    return { contract_version: 1, status: "updated" };
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    console.log(JSON.stringify(await run_peer_command(process.argv.slice(2))));
  } catch {
    console.error(
      "Peer administration failed; check protected local configuration and command arguments",
    );
    process.exitCode = 1;
  }
}
