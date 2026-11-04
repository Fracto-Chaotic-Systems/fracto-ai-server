import express from "express";

export const SERVICE_NAME = "fracto-ai-server";

/** Health describes this process only; no model or remote service is required. */
export const create_app = () => {
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
  // Do not echo request paths, headers, bodies, or identity into responses/logs.
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
