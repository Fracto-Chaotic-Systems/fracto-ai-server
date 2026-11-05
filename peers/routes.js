import { uuid } from "../inference/contracts.js";
import { digest_id, integer } from "../exchange/contracts.js";

/** Every network path and scope is owned here, never a request-supplied URL. */
export const peer_route = (route) => {
  if (typeof route === "string" && route.length <= 200) {
    const manifest =
      /^\/peer\/v1\/distribution\/(knowledge|skill)\/manifest\/([^/]+)\/(0|[1-9]\d{0,15})$/.exec(
        route,
      );
    if (
      manifest &&
      (manifest[2] === "start" || uuid(manifest[2])) &&
      integer(Number(manifest[3])) &&
      (manifest[2] !== "start" || manifest[3] === "0")
    )
      return {
        type: "distribution_manifest",
        kind: manifest[1],
        scope:
          manifest[1] === "knowledge"
            ? "knowledge:exchange"
            : "skills:exchange",
        max_bytes: 8192,
        epoch: manifest[2],
        cursor: Number(manifest[3]),
      };
    const blob =
      /^\/peer\/v1\/distribution\/(knowledge|skill)\/blob\/([a-f0-9]{64})$/.exec(
        route,
      );
    if (blob)
      return {
        type: "distribution_blob",
        kind: blob[1],
        scope:
          blob[1] === "knowledge" ? "knowledge:exchange" : "skills:exchange",
        max_bytes: 196608,
        digest: blob[2],
      };
  }
  if (route === "/peer/v1/delegations/capabilities")
    return {
      type: "delegation_capabilities",
      scope: "inference:delegate",
      max_bytes: 8192,
    };
  if (route === "/peer/v1/delegations")
    return {
      type: "delegation_submit",
      scope: "inference:delegate",
      max_bytes: 8192,
      method: "POST",
      max_body: 4096,
    };
  if (route === "/peer/v1/status")
    return { type: "status", scope: "status:read", max_bytes: 4096 };
  if (route === "/peer/v1/artifacts/metadata")
    return { type: "metadata", scope: "artifacts:exchange", max_bytes: 8192 };
  if (typeof route !== "string" || route.length > 200) return null;
  const delegated = /^\/peer\/v1\/delegations\/([^/]+)(\/cancel)?$/.exec(route);
  if (delegated && uuid(delegated[1]))
    return {
      type: delegated[2] ? "delegation_cancel" : "delegation_status",
      scope: "inference:delegate",
      max_bytes: 8192,
      method: delegated[2] ? "POST" : "GET",
      id: delegated[1],
    };
  const manifest =
    /^\/peer\/v1\/artifacts\/manifest\/([^/]+)\/(0|[1-9]\d{0,15})$/.exec(route);
  if (
    manifest &&
    (uuid(manifest[1]) || manifest[1] === "start") &&
    integer(Number(manifest[2])) &&
    (manifest[1] !== "start" || manifest[2] === "0")
  )
    return {
      type: "manifest",
      scope: "artifacts:exchange",
      max_bytes: 8192,
      epoch: manifest[1],
      cursor: Number(manifest[2]),
    };
  const blob = /^\/peer\/v1\/artifacts\/blob\/([^/]+)$/.exec(route);
  if (blob && digest_id(blob[1]))
    return {
      type: "blob",
      scope: "artifacts:exchange",
      max_bytes: 8192,
      digest: blob[1],
    };
  return null;
};
