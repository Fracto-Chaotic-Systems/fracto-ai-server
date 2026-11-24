const clarification = (question) => ({
  summary: "The wooded-path layout needs clarification.",
  questions: [question],
  assumptions: [],
  actions: [],
});
const targets = { grass: 0.4, shrub: 1, tree: 5 };

/** Reviewed geometry, not generated code. Counts and dimensions remain model
 * parameters; pins, scale fit, bounds and seeded expansion remain server-owned. */
export function compile_wooded_path(parameters, bindings, materials) {
  const p = parameters;
  if (p.questions.length)
    return {
      summary: "The wooded-path layout needs clarification.",
      questions: p.questions,
      assumptions: [],
      actions: [],
    };
  const total = p.grass.count + p.shrub.count + p.tree.count;
  if (total > 1000)
    return clarification(
      "The requested plant count exceeds the 1,000-instance stage limit. Reduce the counts.",
    );
  const [width, depth] = p.size,
    along = p.corridor_axis === "z" ? depth : width,
    cross = p.corridor_axis === "z" ? width : depth;
  const low = p.corridor_center - p.corridor_width / 2,
    high = p.corridor_center + p.corridor_width / 2;
  if (low < -cross / 2 || high > cross / 2 || p.corridor_width >= cross)
    return clarification(
      "The corridor must fit within the floor and leave room for vegetation. Change its width, offset or floor size.",
    );
  const border = Math.max(low + cross / 2, cross / 2 - high);
  const bounds = [-width / 2, -depth / 2, width / 2, depth / 2];
  const exclusion =
    p.corridor_axis === "z"
      ? [low, -depth / 2, high, depth / 2]
      : [-width / 2, low, width / 2, high];
  const actions = [
    {
      type: "floor",
      material: bindings.surface,
      size: p.size,
      texture: bindings.texture,
    },
  ];
  const assumptions = [
    `Corridor follows ${p.corridor_axis.toUpperCase()} at offset ${p.corridor_center} m; seeded layout ${p.seed}.`,
  ];
  for (const [index, role] of ["grass", "shrub", "tree"].entries()) {
    const wanted = p[role];
    if (!wanted.count) continue;
    const facts = materials[bindings[role]].material.construction;
    const height = facts.dimensions_m["xyz".indexOf(facts.up_axis.at(-1))];
    if (!(height > 0))
      return clarification(
        `The ${role} material needs a positive calibrated vertical extent.`,
      );
    // The diagonal bounds every yaw, not just the unrotated footprint. A margin
    // leaves a useful rejection-sampling area even for broad tree canopies.
    const fit =
      (0.9 * Math.min(border, along)) / Math.hypot(...facts.footprint_m);
    let scale;
    if (wanted.height_m !== null && wanted.scale_range !== null)
      return clarification(
        `Specify either ${role} height or scale, rather than both.`,
      );
    if (wanted.scale_range !== null) scale = wanted.scale_range;
    else if (wanted.height_m !== null)
      scale = [wanted.height_m / height, wanted.height_m / height];
    else {
      const maximum = Math.min(targets[role] / height, fit, 1000);
      scale = [0.85 * maximum, maximum];
    }
    if (
      scale[0] < 0.001 ||
      scale[0] > scale[1] ||
      scale[1] > Math.min(fit, 1000)
    )
      return clarification(
        `The requested ${role} height/scale cannot fit the full footprint beside this corridor. Enlarge the floor or reduce it.`,
      );
    actions.push({
      type: "scatter",
      material: bindings[role],
      seed: (p.seed + index) >>> 0,
      count: wanted.count,
      bounds,
      exclusions: [exclusion],
      scale_range: scale,
    });
    assumptions.push(
      `${role}: uniform scale ${scale[0].toFixed(4)}–${scale[1].toFixed(4)}, height ${(height * scale[0]).toFixed(2)}–${(height * scale[1]).toFixed(2)} m${wanted.height_m === null && wanted.scale_range === null ? " (automatic fit)" : " (requested)"}.`,
    );
  }
  return {
    summary: `Propose ${p.grass.count} grass, ${p.shrub.count} shrubs and ${p.tree.count} trees on a ${width} × ${depth} m floor.`,
    questions: [],
    assumptions,
    actions,
  };
}
