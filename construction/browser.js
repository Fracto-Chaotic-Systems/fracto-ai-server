import express from "express";
import { require_enabled_user_if_configured } from "@fracto/sdk/utils/ServiceAuthorization.js";
import { trusted_mutation_origin } from "@fracto/sdk/utils/AuthRequestOrigin.js";
import { InferenceError } from "../inference/contracts.js";
import { register_construction_route } from "./http.js";

// Dedicated browser capability, never a generic tunnel into machine inference.
export function construction_browser_router(
  service,
  {
    authorize = require_enabled_user_if_configured,
    trusted_origin = trusted_mutation_origin,
  } = {},
) {
  const router = express.Router();
  let credits = 6,
    last = Date.now();
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (req.method !== "POST" || req.path !== "/plan")
      return res.status(404).json({ error: "NOT_FOUND" });
    if (trusted_origin(req, res)) return authorize(req, res, next);
  });
  router.use((req, res, next) => {
    if (!service)
      return res.status(503).json({ error: "CONSTRUCTION_UNAVAILABLE" });
    const now = Date.now();
    credits = Math.min(6, credits + (now - last) / 10000);
    last = now;
    if (credits < 1)
      return res
        .status(429)
        .set("Retry-After", "10")
        .json({ error: "RATE_LIMITED" });
    credits--;
    next();
  });
  register_construction_route(router, service, "/plan");
  router.use((error, req, res, next) => {
    if (res.destroyed) return;
    if (error instanceof InferenceError)
      return res.status(error.status).json({ error: error.code });
    const status =
      error.type === "entity.too.large"
        ? 413
        : [400, 415].includes(error.status)
          ? error.status
          : 503;
    res
      .status(status)
      .json({
        error:
          status === 503
            ? "CONSTRUCTION_UNAVAILABLE"
            : "CONSTRUCTION_INVALID_REQUEST",
      });
  });
  return router;
}
