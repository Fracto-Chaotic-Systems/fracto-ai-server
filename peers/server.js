import https from "node:https";
import { constants } from "node:crypto";
import { certificate_info } from "./identity.js";
import { peer_route } from "./routes.js";
import { ArtifactError } from "../exchange/contracts.js";
import { handle_delegation } from "../delegation/peer_http.js";
import { DistributionError } from "../distribution/contracts.js";

export const tls_settings = (identity, peers) => ({
  key: identity.private_key,
  cert: identity.certificate,
  ca: peers
    .filter((peer) => !peer.revoked)
    .map((peer) => peer.certificate)
    .concat(identity.certificate),
  requestCert: true,
  rejectUnauthorized: true,
  minVersion: "TLSv1.3",
  secureOptions: constants.SSL_OP_NO_TICKET,
});
export const connection_status = (
  identity,
  artifacts = false,
  delegation = false,
) => ({
  contract_version: 1,
  service: "fracto-ai-peer",
  node_id: identity.node_id,
  status: "ready",
  capabilities: { status: true, artifacts, delegation },
});
/** Only this listener has peer routes. Local inference credentials have no role. */
export const create_peer_server = ({
  identity,
  get_peers,
  get_exchange = () => null,
  get_delegation = () => null,
  get_distribution = () => null,
}) => {
  const sockets = new Set();
  const buckets = new Map();
  let connection_credits = 32;
  let last_connection = Date.now();
  const server = https.createServer(
    {
      ...tls_settings(identity, get_peers()),
      handshakeTimeout: 3000,
      maxHeaderSize: 4096,
    },
    (req, res) => {
      const send = (status, body) => {
        if (res.destroyed) return;
        res.writeHead(status, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          Connection: "close",
        });
        res.end(Buffer.isBuffer(body) ? body : JSON.stringify(body));
      };
      res.on("error", () => {});
      let trusted;
      try {
        const raw = req.socket.getPeerX509Certificate();
        trusted = get_peers().find(
          (peer) => !peer.revoked && peer.fingerprint === raw?.fingerprint256,
        );
        if (!req.socket.authorized || !trusted)
          return send(401, { error: "UNAUTHORIZED" });
        certificate_info(raw.toString(), trusted.node_id);
      } catch {
        return send(401, { error: "UNAUTHORIZED" });
      }
      const route = peer_route(req.url);
      const content_length = Number(req.headers["content-length"] || 0);
      if (
        req.rawHeaders.length > 32 ||
        req.headers.host !== "fracto-peer.invalid" ||
        req.headers.origin ||
        req.headers.cookie ||
        req.headers.authorization ||
        req.headers["x-fracto-ai-token"] ||
        req.headers["transfer-encoding"] ||
        req.headers["content-encoding"] ||
        !Number.isInteger(content_length) ||
        content_length < 0 ||
        content_length > (route?.max_body || 0) ||
        (route?.type === "delegation_submit" &&
          (content_length < 2 ||
            req.headers["content-type"]?.split(";")[0] !== "application/json"))
      )
        return send(400, { error: "INVALID_REQUEST" });
      const now = Date.now();
      const previous = buckets.get(trusted.node_id) || { credits: 10, at: now };
      const credits = Math.min(
        10,
        previous.credits + (now - previous.at) / 1000,
      );
      buckets.set(trusted.node_id, {
        credits: Math.max(0, credits - 1),
        at: now,
      });
      for (const id of buckets.keys())
        if (!get_peers().some((peer) => peer.node_id === id && !peer.revoked))
          buckets.delete(id);
      if (credits < 1) return send(429, { error: "RATE_LIMITED" });
      if (!route || req.method !== (route.method || "GET"))
        return send(404, { error: "NOT_FOUND" });
      if (!trusted.inbound_scopes.includes(route.scope))
        return send(403, { error: "SCOPE_DENIED" });
      const exchange = get_exchange();
      if (route.type === "status")
        return send(
          200,
          connection_status(
            identity,
            !!exchange && !exchange.failed && !exchange.closed,
            !!get_delegation(),
          ),
        );
      if (route.type.startsWith("delegation_")) {
        handle_delegation({
          runtime: get_delegation(),
          route,
          req,
          sender: trusted.node_id,
          send,
        }).catch(() =>
          send(503, {
            contract_version: 1,
            error: "DELEGATION_UNAVAILABLE",
            acceptance: "unknown",
          }),
        );
        return;
      }
      if (route.type.startsWith("distribution_")) {
        try {
          const distribution = get_distribution();
          if (!distribution)
            return send(503, { error: "DISTRIBUTION_UNAVAILABLE" });
          return send(
            200,
            route.type === "distribution_manifest"
              ? distribution.manifest(route.kind, route.epoch, route.cursor)
              : distribution.blob(route.kind, route.digest),
          );
        } catch (error) {
          return send(error instanceof DistributionError ? error.status : 503, {
            error:
              error instanceof DistributionError
                ? error.code
                : "DISTRIBUTION_UNAVAILABLE",
          });
        }
      }
      if (!exchange) return send(503, { error: "EXCHANGE_UNAVAILABLE" });
      try {
        if (route.type === "manifest")
          return send(200, exchange.manifest(route.epoch, route.cursor));
        if (route.type === "blob")
          return send(200, exchange.blob(route.digest));
        return send(200, exchange.metadata());
      } catch (error) {
        if (error instanceof ArtifactError)
          return send(error.status, { error: error.code });
        return send(503, { error: "EXCHANGE_UNAVAILABLE" });
      }
    },
  );
  server.maxConnections = 32;
  server.maxHeadersCount = 16;
  server.maxRequestsPerSocket = 1;
  server.requestTimeout = 3000;
  server.headersTimeout = 3000;
  server.keepAliveTimeout = 1;
  server.on("connection", (socket) => {
    const now = Date.now();
    connection_credits = Math.min(
      32,
      connection_credits + (now - last_connection) / 125,
    );
    last_connection = now;
    if (connection_credits < 1) {
      socket.destroy();
      return;
    }
    connection_credits--;
    sockets.add(socket);
    const timeout = setTimeout(() => socket.destroy(), 5000);
    timeout.unref();
    socket.on("error", () => {});
    socket.once("close", () => {
      clearTimeout(timeout);
      sockets.delete(socket);
    });
  });
  server.on("tlsClientError", () => {});
  server.on("clientError", (error, socket) => socket.destroy());
  return {
    server,
    disconnect: () => {
      for (const socket of sockets) socket.destroy();
    },
  };
};
