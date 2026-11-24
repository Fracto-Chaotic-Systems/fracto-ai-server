# Construction latency investigation — 2026-11-23

**Final live acceptance: pass in 9.125 and 9.316 seconds from an unloaded model.**
The first run after enabling GPU acceleration passed in 17.293 seconds. These
plain-floor measurements replace the earlier unresolved-latency status; arbitrary
material-build latency and creative quality are not established by this check.

## Integrated GPU and final deployed measurements

After moving weights to NVMe, generation remained CPU-bound. The native log
explicitly reported `dropping integrated GPU; to enable, set OLLAMA_IGPU_ENABLE=1`.
The Intel Arc 140V and Vulkan runtime were already installed. The controller now
supports optional versioned `runtime/ollama/acceleration.json`, ignored by Git.
This installation selects `{"schema_version":1,"integrated_gpu":true}`; the
controller sets `OLLAMA_IGPU_ENABLE=1` and `OLLAMA_VULKAN=1` for its child only.
An absent file preserves existing defaults; false opts back out and invalid data
fails closed. These controls are defined in Ollama's
[environment configuration](https://github.com/ollama/ollama/blob/main/envconfig/config.go).
Native logs confirm **37/37 layers offloaded**.

| Deployed live run | Total | Retrieval load | Retrieval total | Construction total | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| First GPU initialization | 17.293 s | 9.242 s | 14.167 s | 3.017 s | Pass |
| GPU, model initially unloaded | 9.125 s | 4.870 s | 5.937 s | 3.082 s | Pass |
| GPU, model initially unloaded | 9.316 s | 4.870 s | 6.015 s | 3.270 s | Pass |

All six normal services were healthy before final acceptance. Every scene criterion
and proposal/base/preview binding check passed: neutral 4 × 12 m floor, no objects,
valid SDK replay. The engine unloaded after each request. No persistent component
or preference was changed. Model, quantization, context, output caps, single-slot
admission and deadlines are unchanged. No driver installation, antivirus exclusion,
priority change, model download, canned proposal or global environment change was
used. Prompt evaluation now takes about 0.4–0.5 s per phase; construction generation
takes 2.4–2.7 s for 71 tokens. Reported load time includes more than native runner
startup; the table uses the API's phase metrics.

The NVMe and GPU settings survive managed controller restarts. The first GPU
initialization is slower than subsequent model loads. Host contention can still
affect timing: a CPU-only deployed run immediately after full stack startup took
33.716 s with an 8.296 s cold load. The GPU is material to the interactive result
on this host. The three samples are not a general latency distribution.

The native loading bottleneck was the USB HDD model store. It now uses a verified
copy on internal NVMe; the USB original is preserved. Cold loading fell from
57–97 seconds to 2.3–4.7 seconds in the storage comparisons. Construction now uses
up to four CPU threads and compact floor output. The configured model,
quantization, context (4096), output limits, admission policy and deadlines are
unchanged. Ordinary inference remains at two threads. No components or preferences
were saved by the evaluation.

## Native I/O bottleneck and durable storage fix

The checkout and original model store are on D:, an external Seagate USB HDD;
C: is internal NVMe. Sampling a native cold warm-up showed RSS and I/O advancing
only about 20–40 MiB/s, while cumulative CPU time increased by less than half a
second over fourteen seconds. The engine and runner had normal I/O priority.
The native log reported 35.6 seconds to load, without a generation prompt. A
buffered pre-read on a later attempt took 48.7 seconds, followed by a 91.4-second
memory-mapped load. The earlier one-second cached read did not establish sustained
uncached storage performance. Memory mapping alone is not the fix.

`migrate_ollama_models_windows.ps1` copied the existing blobs, manifests (including
v2) and metadata to `%LOCALAPPDATA%\Fracto\ollama\models` and verified the blob
digests. Only after all copies passed did it atomically publish ignored
`runtime/ollama/storage.json`. The controller resolves this versioned setting;
legacy installations without it retain their original model directory. Missing
configured storage fails closed, existing different destination files are never
overwritten, and originals are never deleted. No engine upgrade, model download,
antivirus exclusion, priority change or global environment change was used.

Two live runs with only storage changed passed in 45.505 and 40.784 seconds, with
cold loads of 4.671 and 3.693 seconds. A subsequent storage-only capture loaded
in 2.556 seconds. These comparisons identify the dominant cold-load bottleneck;
prompt processing and generation then dominate the remaining latency.

An isolated actual-planner comparison with compact JSON and four threads produced
the correct floor in 18.554 seconds (2.304-second cold load). Its construction
output used 79 tokens rather than 196. The bounded session profile caps threads
at four and the calling host's available parallelism; all work remains within the
existing single admission slot. General generation and job provenance remain at
two threads. Explicit dimensions do not generate unnecessary assumptions, while
missing requested materials still require questions. No substring shortcut or
hard-coded floor proposal bypasses either model phase or SDK validation.

## Earlier investigation and changes

- The earlier plain-floor request timed out after 170,029 ms. Engine diagnostics
  reproduced runners stalled during loading, before token generation. A verified
  weight checksum and a cached sequential read of the entire 2.5 GB file completed
  in 1,038 ms. This rules out corrupt weights but does not isolate the native
  loader's internal wait. Do not attribute every delay to prompt evaluation.
- The development tile worker retained about 11,312 MiB RSS. Coverage startup
  duplicated the already loaded compiled spatial index into shortcode Sets.
  Membership construction now happens on the first coverage request; startup
  counts use existing column lengths. With the normal tile service responding
  HTTP 200, RSS measured 9,387 MiB and container free memory 4,457 MiB. This saves
  about 1.9 GiB at startup; requesting coverage still incurs the original Set
  allocation. The configured 2,048 MiB free-memory admission guard is unchanged.
- A construction request performs retrieval and construction model calls. They
  now share an internal session: successful calls retain weights for 30 seconds,
  and completion/failure/cancellation explicitly unloads them with a separate
  five-second cleanup deadline. Admission remains occupied through cleanup.
  Ordinary single-call requests retain immediate unloading. Failed cleanup
  preserves the original result/error; the last successful call has a bounded
  expiry. There is no caller-supplied keep-alive override or automatic retry.
- Without usable materials or editable targets, the construction schema exposes
  only floor/clear-floor actions and a shorter matching prompt. Missing materials
  still require questions; no substitute floor is silently authorized. Existing
  schema validation, command translation and SDK replay remain authoritative.
- Responses and evaluation reports expose allowlisted numeric phase measurements:
  elapsed, native load, prompt evaluation, generation and token counts. They
  exclude raw provider output, credentials and model/account identifiers.

A controlled minimal-response A/B after recycling the runner completed in
3,861 ms with immediate unload and 3,551 ms with brief retention. Immediate unload
does **not** intrinsically cause a native hang. Session reuse removes redundant
loading; it does not establish the cause of the first-load stall.

A final explicit CPU memory-mapping diagnostic also stalled during native loading
and was cancelled at 90 seconds. That option was not adopted; the engine's
existing loading policy is unchanged.

## Historical USB plain-floor reruns

Both requests began with no model loaded and used the normal running services.
The evaluator checked a neutral 4 × 12 m floor, no objects, command replay,
unchanged base and matching proposal preview hashes. All seven scene criteria
passed. The model was unloaded after each completed request.

| Capture (UTC) | Total | Retrieval load | Retrieval total | Construction load | Construction total | Result |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Historical baseline, 19:45 | 170.029 s | Unavailable | Unavailable | Unavailable | Unavailable | Deadline exceeded |
| Rerun, 21:50 | 134.888 s | 96.950 s | 105.355 s | 0.039 s | 29.491 s | Pass |
| Rerun, 21:52 | 92.771 s | 57.089 s | 65.062 s | 0.004 s | 27.681 s | Pass |

The latest (now NVMe/GPU) raw capture is the ignored runtime file
`runtime/construction-evaluation-plain-floor.json`. The original full live report
is preserved separately. These historical runs are two observations, not a latency distribution
or a guarantee under future host load. No material-build or memory-benefit claim
follows from this plain-floor result. Dirt search still returned zero matches;
all ten returned grass/shrub/tree materials still lack construction calibration.

## Verification and reproduction

AI engine/session, construction and evaluator tests pass, including cancellation,
cleanup failure, admission occupancy, schema narrowing, timing projection and
floor-only evaluation. Chat, inference, reference and streaming regressions pass;
all 117 AI JavaScript files pass syntax checks. Native installer, verified-copy,
conflict/corruption/nesting and acceleration-profile tests pass. SDK coverage initialization,
classification results, reuse/reset, tile startup/cache and tile-access tests
pass. The repository dependency audit reports zero violations.

From the AI service, with the configured local model and normal stack running:

```text
npm run construction:evaluate -- --live --plain-floor --write --summary
```

This runs one live proposal, never applies or saves it, and writes the separate
plain-floor report. Full material builds remain gated on catalog readiness.

During diagnosis a development-only heap inspection reclaimed no memory and an
error in its cleanup callback stopped the tile child worker. Full development
service supervision was restored before either accepted live run. Freed memory
from that outage was not used as evidence of a fix.
