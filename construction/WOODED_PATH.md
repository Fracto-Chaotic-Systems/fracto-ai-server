# Reviewed wooded-path composition

For a new empty wooded scene with a calibrated floor surface and individually
tagged grass, shrub and tree models, the second model call extracts parameters
instead of inventing placement commands. The server compiles those parameters
into one floor and up to three seeded SDK scatter rules. Counts, floor dimensions,
corridor width/direction/offset and explicit heights/scales come from the current
brief and supplied guidance; there are no evaluation counts or dimensions in the
compiler. Current directions continue to override remembered guidance.

`wooded_path_contract.js` owns bounded parameter schemas, eligibility and the
extraction prompt. `wooded_path.js` owns the reviewed geometry. Other recipes,
existing populated scenes, grouped tree demonstrations or ambiguous surface
images retain the existing general planner path. No generated code executes.
The public proposal contract, Apply, cancellation and Save controls are unchanged.

## Geometry and defaults

- The floor is centered on the XZ origin. “A by B” means width A, depth B unless
  explicitly stated otherwise. The corridor follows the longer dimension unless
  the brief/guidance supplies an axis; its perpendicular center defaults to zero.
- The model returns each role's exact count and seed. Absent an explicit seed,
  the reviewed default is 1. Each role receives a stable derived seed.
- Each scatter uses the floor rectangle as its bounds and the full corridor
  rectangle as an exclusion. The SDK rejects every sampled transform whose
  rotated full footprint overlaps the corridor or crosses floor bounds.
- Automatic target heights are grass 0.4 m, shrub 1 m and tree 5 m, capped to fit.
  The footprint diagonal bounds every yaw. The maximum scale uses 90% of the
  available side-strip/along-floor extent divided by that diagonal; automatic
  variation ranges from 85% to 100% of the resulting scale. This reserves room
  for bounded rejection sampling. Ground anchors and units remain catalog facts.
- Explicit heights/scales are honored or produce a clarification with **no
  edits**, rather than being silently shrunk. Invalid corridor geometry, conflicting
  height/scale requests, unresolved questions and totals over 1,000 instances also
  produce no partial floor or plants. Unsupported individual-position, rotation,
  animation or multiple-corridor instructions must be clarified.

Every proposal discloses corridor assumptions and actual plant scale/height
ranges. With the calibrated broad-canopy `tree-2` on an 8 × 20 m floor with a 2 m
full-footprint corridor, automatic trees are about **1.35–1.59 m tall**. Larger
trees require more floor space or a different material/clearance requirement;
the recipe does not relax corridor clearance to make them fit.

## Safety and verification

The model's parameters are independently schema-validated. The compiler never
invents asset IDs, calibration or image paths. Roles bind to the selected pinned
catalog descriptors, and groups cannot stand in for individual trees. Ambiguous
color-image selection falls back to the general planner. Used revisions are
resolved again after extraction. Existing alias translation, full SDK replay and
base/preview hashes validate the complete batch before it is returned. No
component is saved or applied by planning. The inference admission slot, timeout
and model-session cleanup cover both calls and compilation.

`wooded_path.test.js` checks varied seeds, broad canopies, different floor sizes
and counts, X/Z corridor directions and offsets, explicit heights/scales,
impossible requests, stale pins, unchanged bases and one-step undo/redo. The
representative scripted harness now supplies recipe parameters for eligible
fixtures; it still reports model quality separately from fixture success.

Live reproduction from the AI service:

```text
npm run construction:evaluate -- --live --wooded-path --write --summary
```

The independent evaluator retains the same requested 40 grass / 6 shrubs / 4
trees, 8 × 20 m `dry_dirt` floor, 2 m corridor, full-footprint bounds and texture
criteria. See EVALUATION.md for actual outcomes and timings.
