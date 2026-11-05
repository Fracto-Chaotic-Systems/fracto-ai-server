import express from "express";
import { timingSafeEqual } from "node:crypto";
import { InferenceError, uuid } from "./contracts.js";
import { register_exchange_routes } from "../exchange/http.js";
import { register_delegation_routes } from "../delegation/http.js";
import { register_chat_route } from "./chat.js";

/** Machine-only API, independent of browser authentication and bypass settings. */
export const inference_router = (
  service,
  get_exchange = () => null,
  get_delegation = () => null,
) => {
  const router = express.Router();
  let credits = 30;
  let last = Date.now();
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!service)
      return res.status(503).json({ error: "INFERENCE_UNAVAILABLE" });
    const token = req.get("x-fracto-ai-token");
    if (
      req.get("origin") ||
      req.get("cookie") ||
      typeof token !== "string" ||
      !/^[0-9a-f]{64}$/.test(token) ||
      !timingSafeEqual(Buffer.from(token), Buffer.from(service.store.token))
    ) {
      return res.status(401).json({ error: "UNAUTHORIZED" });
    }
    // One installation-wide bucket: no per-user/IP tracking or unbounded maps.
    const now = Date.now();
    credits = Math.min(30, credits + (now - last) / 500);
    last = now;
    if (credits < 1)
      return res
        .status(429)
        .set("Retry-After", "1")
        .json({ error: "RATE_LIMITED" });
    credits--;
    next();
  });
  register_chat_route(router, service);
  router.use(express.json({ limit: 4096, strict: true, inflate: false }));
  router.use((req, res, next) => {
    if (Object.keys(req.query).length)
      return res.status(400).json({ error: "INVALID_REQUEST" });
    next();
  });
  router.get("/status", (req, res) => res.json(service.status()));
  register_exchange_routes(router, get_exchange);
  register_delegation_routes(router, get_delegation);
  router.post("/jobs", async (req, res) => {
    const result = await service.submit(req.body);
    res
      .status(result.replayed ? 200 : 202)
      .json({ ...result.job, replayed: result.replayed });
  });
  router.param("id", (req, res, next, id) => {
    if (!uuid(id)) return res.status(404).json({ error: "NOT_FOUND" });
    next();
  });
  router.get("/jobs/:id", (req, res) =>
    res.json(service.inspect(req.params.id)),
  );
  router.get("/jobs/:id/result", (req, res) =>
    res.json(service.inspect(req.params.id, true)),
  );
  router.post("/jobs/:id/cancel", (req, res) => {
    if (req.body && Object.keys(req.body).length)
      return res.status(400).json({ error: "INVALID_REQUEST" });
    res.json(service.cancel(req.params.id));
  });
  router.use((error, req, res, next) => {
    if (error instanceof InferenceError) {
      if (error.status === 429 || error.status === 503)
        res.set("Retry-After", "5");
      return res.status(error.status).json({ error: error.code });
    }
    const status =
      error.type === "entity.too.large"
        ? 413
        : error.status === 400 || error.status === 415
          ? error.status
          : 503;
    res.status(status).json({
      error: status === 503 ? "INFERENCE_UNAVAILABLE" : "INVALID_REQUEST",
    });
  });
  return router;
};
