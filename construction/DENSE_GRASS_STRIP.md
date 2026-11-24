# Dense grass strip recipe

`dense-grass-strip-v1` is a reviewed server recipe saved from the corrected
grass strip component (revision 4). `dense_grass_strip_recipe.json` preserves all
809 transforms without object/group/document identifiers: 387 overlapping
interior patches at scale 0.55 and 422 smaller perimeter patches at scale 0.15.
The 1 × 20 m floor uses the registered dry_dirt base-color image and physical
texture repeat [1,20]. Yard grass source animation remains in the referenced GLB;
the component stage now loops its first authored wind clip across all patches.
Placement and coverage calibration still describe the static authored pose, not
the animated wind envelope.

This is reusable server-owned construction geometry, available across browser
profiles, rather than an automatically inferred personal preference or a
browser-local remembered text instruction. The original corrected component
remains independent. The recipe is source controlled and reviewed like the
wooded-path compiler. Nothing is trained into model weights.

The live model chooses the recipe and searches the existing catalog by requested
material names, then extracts width/length. Selecting this recipe supplies its
declared catalog dependencies (`yard_grass_motion`, `dry_dirt`); generated recipe
labels cannot accidentally become catalog searches. The compiler reuses the measured
transforms rather than asking the model for hundreds of positions or random
scatter. The catalog is resolved again before a proposal is returned. Exact
material revisions are required: changed calibration produces a question with no
edits until the pattern has been reviewed again. It supports empty stages only,
1 × 20 m and uniformly scaled copies of the same aspect ratio, bounded to scale
0.01–100. Other proportions/extra constraints require clarification, rather than
stretching individual plants or silently changing density. General ground cover
continues to use the existing planner.

The SDK's exact `place-pattern` command contains one pinned `asset` and at most
1,000 `instances`, each with exactly id/position/rotation/scale. It expands to
ordinary editable objects (no new document schema or renderer). The existing
total instance/pin/document bounds, material validation and atomic batch replay
apply. A floor plus this command stays within the eight-command proposal and
256 KiB transport bounds. Preview/Apply re-resolve references and check both
document hashes. Apply creates one undoable snapshot. Cancellation discards the
proposal through the existing admission and UI lifecycle.

Run `node scripts/evaluate_construction.js --live --grass-strip --write --summary`
in the configured AI service environment. This uses the original natural-language
requirement without hidden recipe hints or remembered guidance. It saves an
ignored `runtime/construction-evaluation-grass-strip.json` report and preview
document; it does not save or change any component. Independent scene scoring
checks exact floor, materials, physical texture repeat, interior/edge counts,
grounding, footprint bounds, hash binding and 200,000 samples at 1 cm centers.
Footprint coverage is distinct from opaque grass-blade coverage: the mesh keeps
natural gaps. The original corrected geometry was visually reviewed; these tests
also require transform-for-transform equality with that reviewed recipe.

Live acceptance passed on 2026-11-23 at 23:59 UTC: 20.665 seconds, all 809
transforms identical to the corrected strip, zero outside footprints and zero
uncovered 1 cm samples. See [EVALUATION.md](EVALUATION.md) for timings and evidence.
