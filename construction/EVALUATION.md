# Representative construction evaluation — 2026-11-23

**Live wooded-path acceptance now passes.** The deployed planner produces the
requested 40 grass, 6 shrubs and 4 trees on the 8 × 20 m `dry_dirt` floor, with
zero full-footprint corridor intersections and zero out-of-bounds footprints.
The previous composition failure below is retained as baseline evidence. Real
user-correction savings and broad creative quality remain unmeasured.

## Composition fix and live acceptance — 2026-11-23 23:13 UTC

Eligible new wooded scenes now use the [reviewed wooded-path recipe](WOODED_PATH.md).
The model extracts exact floor, corridor, count and explicit height/scale
parameters. The server binds calibrated individual materials and compiles one
seeded scatter per role, deriving floor bounds, the corridor exclusion and
conservative yaw-safe scale limits. It does not trust the model to invent all
50 placements or silently replace requested quantities. Other layouts/edits
retain the existing general planner. No evaluation numbers are hard-coded in
the compiler, and the independent scene criteria were not relaxed.

All six normal services were healthy before the deployed live rerun. Both calls
used the configured local model and existing admission/deadline policy.

| Live criterion                                                 | Result                               |
| -------------------------------------------------------------- | ------------------------------------ |
| Neutral plain-floor baseline                                   | Pass, 23.044 s                       |
| 8 × 20 m floor using `dry-dirt` and its registered color image | Pass                                 |
| Physical texture repeat [8,20] at 1 m/tile                     | Pass                                 |
| 40 grass, 6 shrubs, 4 trees                                    | Pass: **50 instances**, exact counts |
| Centered 2 m corridor, full rotated footprints                 | Pass: **0 intersections**            |
| All footprints inside the floor                                | Pass: **0 outside**                  |
| Positive height ≤12 m, pin/hash/SDK replay binding             | Pass                                 |

Wooded-path planning took **23.929 s**: 12.749 s retrieval (9.742 s load),
9.976 s parameter extraction (144 output tokens), followed by compilation,
revision rechecks and SDK replay. Status is `proposal`, with no material gaps.
The output is one floor plus three scatter rules, rather than three individual
placements. Counts, bounds, exclusions and seeds survive normal serialization;
the batch remains one undoable edit. Nothing was applied or saved as a component.

The calibrated tree canopy is broad. Automatic fit yields tree heights about
**1.35–1.59 m**, disclosed in the proposal assumptions; grass is 0.34–0.40 m and
shrubs 0.85–1.00 m. An explicitly requested height/scale that cannot fit produces
questions and no partial edits instead of being silently reduced. This confirms
the specified counts/clearance, not mature-tree aesthetics or plant-to-plant
collision avoidance.

Six dedicated recipe tests cover broad canopies over varied seeds, different
counts/dimensions, rotated and offset corridors, explicit constraints, invalid
requests, group exclusion, stale pins, unchanged bases and one-step undo/redo.
The existing eight scripted fixtures, six fault cases, renderer/history and
inference regressions pass. Syntax checks cover 120 AI JavaScript files.
The [latency investigation](LATENCY.md) retains earlier cold-load observations;
host-dependent first-load costs are included in the timing above.

Reproduce with the same baseline and unchanged wooded-path criteria:

```text
npm run construction:evaluate -- --live --wooded-path --write --summary
```

The latest ignored `runtime/construction-evaluation-wooded-path.json` contains
the graded preview document, exact counts, all eight passing criteria and phase
timings. Further acceptance work covers other live build types, actual visual
review and measured user corrections rather than inferring those from this pass.

An additional live request changed the floor to **12 × 30 m**, corridor to **3 m**,
counts to **17 grass / 3 shrubs / 7 trees**, and seed to **73**. It passed in
**22.092 s**, with all 27 instances, zero corridor intersections, zero outside
footprints, texture repeat [12,30] and derived seeds [73,74,75]. Evidence is the
separate ignored `runtime/construction-evaluation-wooded-variant.json`. This
checks live parameter extraction beyond the original evaluation numbers.

## Historical composition failure — 2026-11-23 22:58 UTC

The asset-owned environment/CALIBRATION.md records measured dimensions, unit
conversion, explicit game-scale choices, anchors and whole-group footprints.
Actual Three.js loaders and stage transforms pass all eleven asset checks;
all **16 original source files across eleven assets** retain their registered
SHA-256 hashes. `dry_dirt` supplies its original 2048 × 2048 color PNG with a
curated 1 × 1 m UV tile. A separate normalized `tree-2` GLB fixes divergent FBX
transforms and restores its original leaf PNG with alpha MASK. Originals,
attribution, previous runtimes and source checksum records are preserved.

The final catalog audit reports dirt **1/1**, grass **4/4**, shrub **2/2** and tree
**4/4** returned candidates ready. All six normal services were healthy.

| Live criterion          | Requested                                 | Actual result                              |
| ----------------------- | ----------------------------------------- | ------------------------------------------ |
| Floor/material          | 8 × 20 m, `dry-dirt`                      | Pass; original registered color image used |
| Physical texture repeat | 8 × 20 tiles at 1 m/tile                  | Pass                                       |
| Vegetation counts       | 40 grass, 6 shrubs, 4 trees               | **Fail: 1 grass, 1 shrub, 1 tree**         |
| Centered corridor       | Full footprints outside 2 m walking strip | **Fail: 2 intersections**                  |
| Floor bounds            | All footprints inside 8 × 20 m area       | **Fail: 1 outside**                        |
| Height/scale sanity     | Positive and at most 12 m                 | Pass                                       |

The plain-floor baseline passed in **32.114 s** in this capture (21.593 s native
load under current host conditions). Wooded-path planning took **39.224 s**:
14.890 s retrieval, 22.896 s construction, including an 11.106 s first load.
The model returned a valid floor plus three placements and no scatters, marked
`needs_information`. Catalog gaps were empty. Its JSON/schema validity does not
establish compliance with the user's counts or corridor directions. No draft,
component, preference or recipe was saved/applied.

Initial attempts exposed descriptive rather than literal catalog queries and
malformed action arguments. The planner now requests literal lexical-AND terms,
keeps distinct requested materials represented before alternatives, bounds the
working set to the query count, and uses exact per-action schemas. Required
geometry fields cannot be omitted; irrelevant fields and unseen targets are
rejected. Empty stages do not offer meaningless floor cleanup. Bounded schema
alternatives retain all reference/pattern/depth/size restrictions. These changes
improve retrieval and structural reliability, but do not solve composition.

Reproduce the same baseline plus named-surface build from the AI service:

```text
npm run construction:evaluate -- --live --wooded-path --write --summary
```

The ignored `runtime/construction-evaluation-wooded-path.json` retains complete
criteria, phase timings, material gaps and the generated preview document for
inspection. It is separate from the original full and plain-floor captures.
The remaining acceptance work is a planner that reliably turns quantities and
clearance directions into calibrated scatter recipes, followed by another run
of these unchanged scene criteria and actual visual review. The new calibrated
catalog is no longer the blocker.

## Build cases

Reviewed fixtures use synthetic calibrated dimensions: grass 0.3 × 0.4 × 0.3 m,
shrubs 0.8 × 1 × 0.8 m, trees 2 × 5 × 2 m, and a 1 m dirt texture tile. These
facts are fixtures only. Scripted schema-constrained outputs run through the actual
planner, alias translation, pin rechecks and SDK application. This establishes
pipeline behavior, not model-generated creative quality.

| Case                                     | Criteria                                                                        | Result                                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Plain floor                              | Neutral 4 × 12 m floor, no objects                                              | Pass                                                                                    |
| Wooded path                              | 8 × 20 m dirt floor, 40 grass + 6 shrubs + 4 trees, centered 2 m clear corridor | Pass: 50 instances, zero corridor intersections/out-of-area footprints                  |
| Crossing-path meadow                     | 10 × 10 m floor, 50 grass clumps outside two crossing 2 m strips                | Pass: zero exclusion intersections/out-of-area footprints                               |
| Garden placements                        | Three shrubs + two trees at directed positions, 2 m corridor                    | Pass: correct count, scale and bounds                                                   |
| Refinement                               | Move/rotate/scale existing tree and remove shrub scatter, retain floor          | Pass: exact transform, one remaining instance                                           |
| Preference comparison, guidance omitted  | Assess a fixture's 2 m corridor against a desired 3 m corridor                  | Intentional negative control detected: 12 footprint intersections; one failed criterion |
| Preference comparison, guidance supplied | Fixture uses remembered 3 m corridor                                            | Pass: zero intersections/failed criteria                                                |
| Current-direction override               | Explicit 2 m corridor with remembered 3 m default                               | Pass in scripted fixture                                                                |

All eight cases meet their evaluation expectations: seven positive scenes pass
and the intentionally inadequate control is detected. A valid command batch alone
is not counted as a successful creative result. Full rotated footprints are
scored after seeded expansion. Criteria include counts, floor/material/texture
repeats, authored transforms, extents and a fixture-specific 12 m height ceiling.
This is not a general aesthetics, inter-object collision or accessibility assessment.

Each case passes unchanged-base/preview-hash checks, one-batch history, undo/redo,
canonical JSON roundtrip and identical regenerated transforms after reload.
Six fault cases pass: missing material and missing calibration yield gaps without
edits; unavailable catalog, unavailable engine, stale revision and impossible
packing fail without changing the populated base draft. UI hook tests separately
confirm draft/revision/history retention on inference or catalog-preparation failure.

## Renderer and persistence

The UI evaluation applies every batch through the actual proposal reducer, creates
real Three.js scene geometry at authored meter scale, checks counts/extents and
updates geometry after undo/redo. Synthetic box prototypes and neutral preview
floors avoid external model/image decoding. This does not establish visual quality,
actual catalog model fidelity or texture appearance.

All eight complete documents passed actual MySQL create/load/update/conflict
checks through the data service repository, with a new repository instance for
reload. Canonical document bytes and generated transforms survive; stale writers
cannot replace a newer revision. Tests use connection-local temporary tables and
fresh document UUIDs. They create no persistent evaluation components and do not
claim full service-restart or power-loss durability.

## Initial live catalog and model (before calibration)

Read-only keyword searches requested four candidates each:

| Query | Total matches | Placement-ready among returned matches |
| ----- | ------------: | -------------------------------------: |
| dirt  |             0 |                                      0 |
| grass |             4 |                                      0 |
| shrub |             2 |                                      0 |
| tree  |             4 |                                      0 |

Each returned vegetation candidate lacks kind, placement, unit conversion,
dimensions, axes, ground anchor and footprint. Zero dirt keyword matches does
not establish that no suitable texture exists elsewhere; naming/tagging and
registration need review. Calibration values were not invented for these assets.

The live machine API received an ephemeral plain-floor document and explicit
4 × 12 m dimensions, with no catalog materials requested. The run started at
19:45:43 UTC on 2026-11-23 and returned `DEADLINE_EXCEEDED` after **170,029 ms**.
No usable proposal was returned. Generation has a 170-second budget inside the
175-second planner deadline; existing limits were preserved. Afterwards, the
engine reported ready with zero active requests.

Further live builds and the memory comparison were gated off after that baseline
failure. There is no live pass rate, time-to-usable-build or measured reduction in
human corrections. The scripted comparison changes a failed-criteria proxy from
one to zero; that is not evidence of learned preferences or improved model behavior.
The timeout does not identify which planner phase or engine operation dominates.

## Reproduction

From the AI service:

```text
npm run construction:evaluate -- --summary
npm run construction:evaluate -- --catalog --write --summary
npm run construction:evaluate -- --live --write --summary
npm run construction:evaluate -- --live --plain-floor --write --summary
```

Default mode is offline/scripted. Catalog mode adds read-only asset API searches.
Live mode uses the existing protected credential and configured model, stops
further generation after a failed baseline and gates material builds on catalog
readiness. If the baseline passes, floor refinement and paired floor-width
preference/override checks can run independently of calibration. The pair has
one sample per condition and measures failed scene criteria, not human edits.
Ambiguous catalog-role matches fail scoring explicitly.

`--write` stores result fields in ignored service runtime files:
`construction-evaluation-offline.json`, `construction-evaluation-catalog.json`
or `construction-evaluation.json`. A `--live --plain-floor` run writes
`construction-evaluation-plain-floor.json` separately. Reports exclude credentials, raw model output,
account/profile fields and browser memory. Offline/catalog runs preserve live
evidence. The first live capture used the baseline/audit runner before the offline
suite was expanded; its measured timeout remains the evidence above. Required
failures exit nonzero; skipped builds are not passes.

Root `npm run test:construction-evaluation` runs owner-specific evaluator, renderer,
hook and persistence tests. Set `FRACTO_TEST_COMPONENT_DATABASE=1` for actual SQL
checks; configured MySQL and migration 024 are required. The representative
temporary-table test was executed successfully in the development container.
Existing planner/memory regressions remain in `npm run test:construction-planner`.

## Acceptance follow-up

1. Plain-floor baseline restored under the current admission/deadline policy;
   interactive plain-floor latency measured at 9.1–9.3 seconds after GPU
   initialization. See LATENCY.md for phase timings, first-run cost and limits.
2. Completed: calibrated all ten vegetation materials and registered `dry_dirt`
   with its original color texture and explicit tile scale.
3. Wooded-path composition fixed and live acceptance passes as detailed above.
   Continue with live crossing-path/garden cases and actual visual/material review.
4. Repeat matched briefs with/without saved patterns and record actual correction
   counts and time-to-accepted-result before claiming memory benefit.

# Dense grass strip acceptance — 2026-11-23

The live configured construction model reproduced the corrected grass strip from
this original requirement, with no remembered guidance or recipe hint in the
request: “Make a strip of grass 1m wide and 20m long, filling it completely with
yard_grass_motion with a background texture of dry_dirt.”

The accepted run started at 23:58:47 UTC and finished at 23:59:09 UTC. Build
evaluation took **20.665 seconds** (planner 19.327 seconds). Retrieval took
14.551 seconds, including 11.264 seconds of native load; dimension extraction
took 2.728 seconds. All eleven scene/proposal checks passed:

- Correct 1 × 20 m dry_dirt floor and physical texture repeat [1,20].
- Exactly 809 yard_grass_motion objects: 387 interior and 422 perimeter patches.
- Zero footprints outside the floor; grounded at Y=0.
- Zero uncovered samples among 200,000 samples at 1 cm centers.
- Valid base/preview hashes, ready proposal, and dense-grass-strip-v1 selection.

A separate comparison of the live preview to the saved recipe confirmed all
809 position/yaw/scale tuples match the previously corrected component exactly.
Coverage measures conservative calibrated footprints, not opaque blade pixels;
the authored grass mesh retains natural gaps. The previously reviewed rendering
is reproduced without replacing source assets. No evaluation component was saved;
the existing grass strip remained at revision 4.

The first live attempt selected the right recipe but searched for its recipe
label instead of its materials (40.540 seconds; needs_information). This failed
evidence is retained in ignored
`runtime/construction-evaluation-grass-strip-initial-query-failure.json`.
The recipe now declares its material search dependencies; a regression test
supplies the erroneous label and checks correct live catalog lookup. A stale
development watcher briefly repeated the failure before a full service restart.
The accepted report is `runtime/construction-evaluation-grass-strip.json` and
includes the full preview document. Rerun with
`node scripts/evaluate_construction.js --live --grass-strip --write --summary`.

The [saved recipe](DENSE_GRASS_STRIP.md) supports empty scenes and uniform copies
of the reviewed 1:20 proportions; other proportions, extra placement constraints
or changed catalog revisions require clarification. This acceptance does not
establish arbitrary dense-fill geometry or learned user preferences.

Verification: all 264 AI service tests passed; the post-fix focused planner suite
passed all 15 tests. The representative construction suite passed 31 tests with
three opt-in persistence tests skipped. UI proposal/hook tests passed all 12;
SDK document/tool tests passed, including added bounded-pattern rejection cases.
Dependency boundary audit reported zero violations. The active UI served the
updated shared-pin proposal support after refresh.
