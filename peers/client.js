import https from "node:https";
import { X509Certificate } from "node:crypto";
import { certificate_info, fields } from "./identity.js";
import { endpoint_url } from "./configuration.js";
import { PeerError, reject } from "./files.js";
import { peer_route } from "./routes.js";

export const validate_status = (value, expected_id) => {
  fields(value, [
    "contract_version",
    "service",
    "node_id",
    "status",
    "capabilities",
  ]);
  fields(value.capabilities, ["status", "artifacts", "delegation"]);
  if (
    value.contract_version !== 1 ||
    value.service !== "fracto-ai-peer" ||
    value.node_id !== expected_id ||
    value.status !== "ready" ||
    value.capabilities.status !== true ||
    typeof value.capabilities.artifacts !== "boolean" ||
    typeof value.capabilities.delegation !== "boolean"
  )
    reject("PEER_PROTOCOL_ERROR");
  return {
    contract_version: 1,
    status: "ready",
    capabilities: {
      status: true,
      artifacts: value.capabilities.artifacts,
      delegation: value.capabilities.delegation,
    },
  };
};
/** Fixed route and headers; no URL, path or credentials come from an API caller. */
export const peer_request = async ({
  identity,
  peer,
  signal,
  timeout_ms = 5000,
  route = "/peer/v1/status",
  method = "GET",
  body,
}) => {
  const descriptor = peer_route(route);
  if (
    !descriptor ||
    !Number.isInteger(timeout_ms) ||
    timeout_ms < 1 ||
    timeout_ms > 5000 ||
    method !== (descriptor?.method || "GET")
  )
    reject("PEER_PROTOCOL_ERROR");
  if (peer.revoked || !peer.outbound_scopes.includes(descriptor.scope))
    reject("SCOPE_DENIED");
  const bytes_out =
    body === undefined ? null : Buffer.from(JSON.stringify(body));
  if (
    (bytes_out &&
      (!descriptor.max_body || bytes_out.length > descriptor.max_body)) ||
    (descriptor.type === "delegation_submit" && !bytes_out)
  )
    reject("PEER_PROTOCOL_ERROR");
  const url = endpoint_url(peer.endpoint);
  const deadline = new AbortController();
  const combined = signal
    ? AbortSignal.any([signal, deadline.signal])
    : deadline.signal;
  const timer = setTimeout(() => deadline.abort(), timeout_ms);
  try {
    return await new Promise((resolve, reject_request) => {
      const request = https.request(
        {
          hostname: url.hostname.replace(/^\[|\]$/g, ""),
          port: Number(url.port),
          path: route,
          method,
          key: identity.private_key,
          cert: identity.certificate,
          ca: [peer.certificate],
          rejectUnauthorized: true,
          minVersion: "TLSv1.3",
          servername: "",
          checkServerIdentity: (host, certificate) => {
            try {
              const info = certificate_info(
                new X509Certificate(certificate.raw).toString(),
                peer.node_id,
              );
              if (info.fingerprint !== peer.fingerprint)
                return new Error("Peer certificate mismatch");
            } catch {
              return new Error("Peer certificate mismatch");
            }
          },
          headers: {
            Host: "fracto-peer.invalid",
            Accept: "application/json",
            Connection: "close",
            ...(method === "POST"
              ? {
                  "Content-Length": bytes_out?.length || 0,
                  ...(bytes_out ? { "Content-Type": "application/json" } : {}),
                }
              : {}),
          },
          maxHeaderSize: 4096,
          agent: false,
          signal: combined,
        },
        (response) => {
          const failure = (code) => {
            response.destroy();
            reject_request(new PeerError(code));
          };
          const delegation = descriptor.type.startsWith("delegation_");
          if (!delegation && response.statusCode === 403)
            return failure("SCOPE_DENIED");
          if (!delegation && response.statusCode === 429)
            return failure("PEER_BUSY");
          if (
            response.statusCode === 409 &&
            ["manifest", "distribution_manifest"].includes(descriptor.type)
          )
            return failure("RESNAPSHOT_REQUIRED");
          if (
            response.statusCode === 404 &&
            ["blob", "distribution_blob"].includes(descriptor.type)
          )
            return failure("RESNAPSHOT_REQUIRED");
          if (
            (!delegation
              ? response.statusCode !== 200
              : ![
                  200, 202, 400, 403, 404, 408, 409, 413, 415, 429, 503,
                ].includes(response.statusCode)) ||
            response.headers["content-type"]?.split(";")[0] !==
              "application/json" ||
            response.headers["content-encoding"]
          )
            return failure("PEER_PROTOCOL_ERROR");
          const chunks = [];
          let size = 0;
          response.on("data", (chunk) => {
            size += chunk.length;
            if (size > descriptor.max_bytes)
              return failure("PEER_PROTOCOL_ERROR");
            chunks.push(chunk);
          });
          response.on("error", () =>
            reject_request(new PeerError("PEER_UNAVAILABLE")),
          );
          response.on("end", () => {
            try {
              const bytes = Buffer.concat(chunks);
              resolve({
                status: response.statusCode,
                bytes,
                value: JSON.parse(
                  new TextDecoder("utf-8", { fatal: true }).decode(bytes),
                ),
              });
            } catch {
              reject_request(new PeerError("PEER_PROTOCOL_ERROR"));
            }
          });
        },
      );
      request.on("error", () =>
        reject_request(new PeerError("PEER_UNAVAILABLE")),
      );
      request.end(bytes_out || undefined);
    });
  } catch (error) {
    if (combined.aborted)
      reject(signal?.aborted ? "CANCELLED" : "PEER_DEADLINE_EXCEEDED");
    if (error instanceof PeerError) throw error;
    reject("PEER_UNAVAILABLE");
  } finally {
    clearTimeout(timer);
  }
};

export const probe_peer = async (options) => {
  const response = await peer_request({ ...options, route: "/peer/v1/status" });
  try {
    return validate_status(response.value, options.peer.node_id);
  } catch {
    reject("PEER_PROTOCOL_ERROR");
  }
};
