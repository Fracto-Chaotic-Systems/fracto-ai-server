import { randomUUID } from "node:crypto";
import { exact } from "./contracts.js";
import { fail } from "../inference/contracts.js";
import { COMPONENT_SCATTER_ALGORITHM } from "@fracto/sdk/FractoComponentScatter.js";
export function translate_actions(actions, materials, targets) {
  const used = new Map();
  const choose = (key) => {
    if (!Object.hasOwn(materials, key))
      fail("CONSTRUCTION_INVALID_OUTPUT", 502);
    const entry = materials[key],
      ref = { id: entry.material.id, revision: entry.material.revision };
    used.set(`${ref.id}:${ref.revision}`, ref);
    return { entry, ref };
  };
  const target = (key, kind) => {
    if (!Object.hasOwn(targets, key) || (kind && targets[key].kind !== kind))
      fail("CONSTRUCTION_INVALID_OUTPUT", 502);
    return targets[key].item;
  };
  const shape = (action, required, optional) => {
    if (!exact(action, ["type", ...required], optional))
      fail("CONSTRUCTION_INVALID_OUTPUT", 502);
  };
  const commands = actions.map((action) => {
    switch (action.type) {
      case "floor": {
        shape(action, ["material", "size"], ["texture", "repeat"]);
        if (action.material === "none") {
          if (action.texture) fail("CONSTRUCTION_INVALID_OUTPUT", 502);
          return {
            type: "set-floor",
            floor: {
              asset: null,
              texture_file: null,
              size: action.size,
              texture_repeat: action.repeat || [1, 1],
            },
          };
        }
        const { entry, ref } = choose(action.material),
          file = entry.textures[action.texture];
        if (!file || entry.material.construction.kind !== "surface")
          fail("CONSTRUCTION_INVALID_OUTPUT", 502);
        return {
          type: "set-floor",
          floor: {
            asset: ref,
            texture_file: file,
            size: action.size,
            texture_repeat:
              action.repeat ||
              action.size.map(
                (size, i) =>
                  size / entry.material.construction.texture_size_m[i],
              ),
          },
        };
      }
      case "clear-floor":
        shape(action, []);
        return { type: "set-floor", floor: null };
      case "place": {
        shape(action, ["material", "position", "rotation", "scale"]);
        return {
          type: "place",
          object: {
            id: randomUUID(),
            asset: choose(action.material).ref,
            position: action.position,
            rotation: action.rotation,
            scale: action.scale,
            group_id: null,
          },
        };
      }
      case "transform": {
        shape(action, ["target", "position", "rotation", "scale"]);
        const item = target(action.target, "object");
        used.set(`${item.asset.id}:${item.asset.revision}`, item.asset);
        return {
          type: "transform",
          id: item.id,
          position: action.position,
          rotation: action.rotation,
          scale: action.scale,
        };
      }
      case "remove":
        shape(action, ["target"]);
        return { type: "remove", id: target(action.target).id };
      case "scatter": {
        shape(
          action,
          ["material", "seed", "count", "bounds", "exclusions", "scale_range"],
          ["target"],
        );
        const item = action.target ? target(action.target, "scatter") : null;
        return {
          type: "scatter",
          rule: {
            id: item?.id || randomUUID(),
            asset: choose(action.material).ref,
            group_id: item?.group_id || null,
            algorithm: COMPONENT_SCATTER_ALGORITHM,
            seed: action.seed,
            count: action.count,
            bounds: action.bounds,
            exclusions: action.exclusions,
            scale: action.scale_range,
          },
        };
      }
      default:
        fail("CONSTRUCTION_INVALID_OUTPUT", 502);
    }
  });
  return { commands, references: [...used.values()] };
}
