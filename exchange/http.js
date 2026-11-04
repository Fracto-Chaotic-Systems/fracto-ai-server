import { InferenceError } from "../inference/contracts.js";
import { ArtifactError, digest_id } from "./contracts.js";
import { peer_route } from "../peers/routes.js";

/** Mounted behind existing local machine authorization, never on public health. */
export const register_exchange_routes = (router, get_exchange) => {
  const handle = (operation) => (req, res, next) => {
    try {
      const exchange = get_exchange();
      if (!exchange) throw new InferenceError("EXCHANGE_UNAVAILABLE", 503);
      res.json(operation(exchange, req));
    } catch (error) {
      if (error instanceof ArtifactError)
        return next(new InferenceError(error.code, error.status));
      next(error);
    }
  };
  router.get(
    "/artifacts/status",
    handle((runtime) => runtime.status()),
  );
  router.get(
    "/artifacts/metadata",
    handle((runtime) => runtime.store.metadata()),
  );
  router.get(
    "/artifacts/inventories",
    handle((runtime) => runtime.store.inventories()),
  );
  router.get(
    "/artifacts/manifest/:epoch/:cursor",
    handle((runtime, req) => {
      const route = peer_route(
        `/peer/v1/artifacts/manifest/${req.params.epoch}/${req.params.cursor}`,
      );
      if (!route) throw new InferenceError("INVALID_REQUEST", 400);
      return runtime.store.manifest(route.epoch, route.cursor);
    }),
  );
  router.get(
    "/artifacts/blob/:digest",
    handle((runtime, req) => {
      if (!digest_id(req.params.digest))
        throw new InferenceError("NOT_FOUND", 404);
      return runtime.store.inspect(req.params.digest);
    }),
  );
};
