# scripts

AI-owned knowledge-bundle build executable. It validates shared contracts through `@fracto/sdk`, consumes UI-published reference inputs and writes AI-owned generated bundles. The root orchestrates the declared UI validation prerequisite and this command.

`plan_construction.js` is the declared local machine caller for the proposal-only
[construction API](../construction/README.md). Supply `--input request.json` or
`--smoke`; `--summary` limits output to status/counts. It reads the existing local
credential, never prints it, and never saves/applies plans or changes models.

`evaluate_construction.js` is the declared construction evaluator. Default mode
runs eight offline scripted builds and six fault cases. `--catalog` adds bounded
read-only asset searches; `--live` adds configured-model proposals with baseline
and calibration gates. `--write` saves separate offline, catalog or live reports
under ignored runtime storage; `--summary` limits stdout. No component/catalog/
preference records are changed. See construction/EVALUATION.md for results and
remaining acceptance blockers.

`--live --grass-strip --write --summary` evaluates the reviewed dense strip from
its original natural-language requirement and writes a separate
`runtime/construction-evaluation-grass-strip.json`. It checks footprint coverage,
edge/interior density, bounds, exact materials and proposal hashes without saving
a component. It cannot be combined with other single-build selectors.

Add `--plain-floor` to `--live` to rerun only the baseline. It writes
`construction-evaluation-plain-floor.json` separately, including bounded planner
phase timings, and leaves the original full evaluation report intact.

`--live --wooded-path` runs the baseline followed by the wooded-path case with
the named `dry_dirt` ground material. It requires all four calibrated catalog
roles and additionally checks that the actual floor reference is `dry-dirt`.
`--write` uses `construction-evaluation-wooded-path.json`, including the generated
preview document for inspection (no component is saved/applied). This mode does
not run unrelated memory or garden cases. It cannot be combined with
`--plain-floor`. Material gaps and scene criteria are retained on failure.
