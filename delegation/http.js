import { InferenceError, uuid } from "../inference/contracts.js";
import { DelegationError } from "./contracts.js";

/** Existing local machine token, never browser bypass or an inbound peer token. */
export const register_delegation_routes = (router, get_runtime) => {
  const handle = (operation) => async (req, res, next) => {
    try {
      const runtime = get_runtime();
      if (!runtime) throw new InferenceError("DELEGATION_UNAVAILABLE", 503);
      await operation(runtime, req, res);
    } catch (error) {
      next(
        error instanceof DelegationError
          ? new InferenceError(error.code, error.status)
          : error,
      );
    }
  };
  router.get(
    "/delegations/status",
    handle((runtime, req, res) => res.json(runtime.status())),
  );
  router.get(
    "/delegations/peers/:peer_id/capabilities",
    handle(async (runtime, req, res) => {
      if (!uuid(req.params.peer_id))
        throw new InferenceError("INVALID_REQUEST", 400);
      res.json(await runtime.capabilities(req.params.peer_id));
    }),
  );
  router.post(
    "/delegations",
    handle((runtime, req, res) => {
      const receipt = runtime.submit(req.body);
      res.status(receipt.replayed ? 200 : 202).json(receipt);
    }),
  );
  router.get(
    "/delegations/:id",
    handle((runtime, req, res) => res.json(runtime.inspect(req.params.id))),
  );
  router.get(
    "/delegations/:id/result",
    handle((runtime, req, res) =>
      res.json(runtime.inspect(req.params.id, true)),
    ),
  );
  router.post(
    "/delegations/:id/cancel",
    handle((runtime, req, res) => {
      if (req.body && Object.keys(req.body).length)
        throw new InferenceError("INVALID_REQUEST", 400);
      res.json(runtime.cancel(req.params.id));
    }),
  );
};
