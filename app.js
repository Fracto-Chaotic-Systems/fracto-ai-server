import express from "express";
import { create_engine_status_reader } from "./engines/registry.js";
import { public_engine_status } from "./engines/public_status.js";
import { inference_router } from "./inference/http.js";
import { public_peer_status } from "./peers/public_status.js";

export const SERVICE_NAME = "fracto-ai-server";

/** Health describes this process only; no model or remote service is required. */
export const create_app = ({
  engine_status = create_engine_status_reader(),
  inference = null,
  peer_status = () => ({ state: "disabled" }),
  get_exchange = () => null,
  get_delegation = () => null,
  knowledge_status = () => null,
  skill_status = () => null,
  distribution_status = () => null,
} = {}) => {
  const app = express();
  app.disable("x-powered-by");
  const health = (req, res) => {
    res.set("Cache-Control", "no-store").json({
      contract_version: 1,
      service: SERVICE_NAME,
      status: "ready",
      stage: "foundation",
      capabilities: [],
      uptime_seconds: Math.floor(process.uptime()),
    });
  };
  app.get("/", health);
  app.get("/healthz", health);
  app.get("/readyz", health);
  app.get("/engine/status", async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      res.json(public_engine_status(await engine_status()));
    } catch {
      res.json(
        public_engine_status({
          state: "engine_unavailable",
          error: "ENGINE_UNAVAILABLE",
        }),
      );
    }
  });
  app.use(
    "/inference",
    inference_router(inference, get_exchange, get_delegation),
  );
  app.get("/peers/status", (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      res.json(public_peer_status(peer_status()));
    } catch {
      res.json(public_peer_status({ state: "unavailable" }));
    }
  });
  app.get("/knowledge/status", (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const status = knowledge_status();
      if (!status || status.state !== "ready") throw new Error();
      const counts = [
        "sources",
        "revisions",
        "revision_limit",
        "document_byte_limit",
        "search_limit",
      ];
      if (
        !counts.every(
          (key) => Number.isSafeInteger(status[key]) && status[key] >= 0,
        )
      )
        throw new Error();
      res.json({
        contract_version: 1,
        state: "ready",
        ...Object.fromEntries(counts.map((key) => [key, status[key]])),
      });
    } catch {
      res.json({ contract_version: 1, state: "unavailable" });
    }
  });
  // Do not echo request paths, headers, bodies, or identity into responses/logs.
  app.get("/skills/status", (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const status = skill_status();
      const keys = ["skills", "active", "versions", "version_limit"];
      if (
        !status ||
        status.state !== "ready" ||
        !keys.every(
          (key) => Number.isSafeInteger(status[key]) && status[key] >= 0,
        )
      )
        throw new Error();
      res.json({
        contract_version: 1,
        state: "ready",
        ...Object.fromEntries(keys.map((key) => [key, status[key]])),
      });
    } catch {
      res.json({ contract_version: 1, state: "unavailable" });
    }
  });
  app.get("/distribution/status", (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const status = distribution_status(),
        keys = ["records", "published", "adoptions", "quarantined"];
      if (
        status?.state !== "ready" ||
        !keys.every(
          (key) => Number.isSafeInteger(status[key]) && status[key] >= 0,
        )
      )
        throw new Error();
      res.json({
        contract_version: 1,
        state: "ready",
        ...Object.fromEntries(keys.map((key) => [key, status[key]])),
      });
    } catch {
      res.json({ contract_version: 1, state: "unavailable" });
    }
  });
  app.use((req, res) => res.status(404).json({ error: "Not found" }));
  return app;
};

export const configured_port = (
  value = process.env.FRACTO_AI_PORT ?? "3007",
) => {
  if (!/^\d+$/.test(String(value))) throw new Error("Invalid FRACTO_AI_PORT");
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid FRACTO_AI_PORT");
  }
  return port;
};

export const configured_host = (
  value = process.env.FRACTO_AI_LISTEN_HOST ?? "127.0.0.1",
) => {
  if (!["127.0.0.1", "0.0.0.0"].includes(value))
    throw new Error("Invalid FRACTO_AI_LISTEN_HOST");
  return value;
};
