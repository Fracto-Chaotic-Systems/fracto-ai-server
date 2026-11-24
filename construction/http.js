import express from "express";
import { fail } from "../inference/contracts.js";
// Mounted after machine authorization and before the smaller durable-job parser.
export function register_construction_route(
  router,
  service,
  route = "/construction/plan",
) {
  router.post(
    route,
    express.json({ limit: "1mb", strict: true, inflate: false }),
    async (req, res) => {
      if (Object.keys(req.query).length) fail("CONSTRUCTION_INVALID_REQUEST");
      const controller = new AbortController();
      const disconnect = () => {
        if (!res.writableEnded) controller.abort();
      };
      req.on("aborted", disconnect);
      res.on("close", disconnect);
      try {
        const result = await service.construction_plan(req.body, {
          signal: controller.signal,
        });
        if (!res.destroyed && !controller.signal.aborted) res.json(result);
      } catch (error) {
        if (!res.destroyed) throw error;
      } finally {
        req.off("aborted", disconnect);
        res.off("close", disconnect);
      }
    },
  );
}
