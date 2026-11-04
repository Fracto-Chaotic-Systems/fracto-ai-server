# Windows baseline benchmarks

## Automatic collection at Fracto startup

The standard Windows production/development launchers, first-run and cold-boot
workflows now start a hidden host observer automatically. Native Windows root
supervisor startup does the same. No label, benchmark command, model installation,
elevation prompt or confirmation is part of the normal workflow. The observer
uses the launching account's existing permissions; it does not bypass execution
policy or grant access if the lab has restricted CIM.

One observer per checkout/main port is enforced with a Windows named mutex.
It watches the main server every five seconds, recognizes each process through
its non-personal `startup_id`, and keeps running across container replacements.
Older running versions are recognized through their approximate boot epoch from
`uptime_seconds`. A readiness fluctuation alone does not start another run.

For each newly observed Fracto startup it automatically:

1. Saves an atomic Windows host inventory immediately.
2. Waits for `/readyz` to stay ready continuously for 30 seconds, resetting the
   settling period if readiness is lost.
3. Collects 12 passive samples at approximately five-second intervals, with the
   same startup identity/readiness checked throughout. The CPU probe is disabled
   for automatic runs to avoid adding synthetic load.
4. Saves the final report atomically. A changed process cancels the old run.
   Completed reports suppress duplicate runs even if the observer itself restarts.
5. Retries failures after 60 seconds, up to three attempts per startup. Readiness
   waiting is limited to 15 minutes; a collector is terminated after 20 minutes.
   Failure never blocks Fracto startup/readiness. A subsequent new startup gets
   its own attempts automatically.

Results stay on the Windows host in this checkout's ignored `runtime/benchmarks/`:

- `windows-baseline-main-<port>-<startup-id>.inventory.json`: initial host inventory.
- `windows-baseline-main-<port>-<startup-id>.json`: completed baseline.
- `startup-benchmark-<port>.status.json`: last observed phase, attempts and result filename.

The most recent 30 automatic startup report sets per port are retained, including
paired inventories and interrupted/failed sets. Failed runs keep their status/inventory and
do not masquerade as completed measurements. Interrupted runs may leave an
inventory without a final report; only final reports count as completed.

This is a Windows-host facility, not a Linux-container memory benchmark. The
Linux supervisor safely skips launching PowerShell. The Windows helper remains
outside the container and does not require access to the Docker API. It starts
through the supported Fracto launchers; bare `docker compose up` alone does not
install/start it. Once running it also observes subsequent direct Docker
restarts. After Windows reboot, the next standard Fracto launch recreates it;
no Windows boot task, system service or registry setting is installed.
`FRACTO_STARTUP_BENCHMARK=false` suppresses new observer launches; this does not
terminate an observer already running from an earlier launch.

Stable readiness is a settling heuristic, not proof that background coverage
preloads or every workload have become idle. Reports describe observed startup
conditions, not normal human interaction or maximum capacity. Neither full logs
nor complete health response bodies are persisted. Only the allowlisted startup
identity/readiness fields are read from the readiness response.

## Manual measurements and diagnostics

`benchmark_windows.ps1` measures step 1 of FIRST_STAGE.md without installing an
engine, pulling a model, starting workloads, changing services, or scanning the
network. Run it locally on each target Windows machine while its usual Fracto
workload is active. Windows PowerShell 5.1 or PowerShell 7 with local CIM access
is required. If CIM is blocked by an execution sandbox, run outside that sandbox;
this does not normally require changing Windows remoting or enabling a service.

From this repository's root:

```powershell
powershell.exe -NoProfile -File .\benchmark_windows.ps1 -NodeLabel lab-48gb
powershell.exe -NoProfile -File .\benchmark_windows.ps1 -NodeLabel lab-64gb
```

Run the matching command on each machine; the labels do not configure or assume
the installed memory. If the script is blocked by policy, follow the lab's
approved execution/signing policy rather than changing machine-wide settings.
The script is self-contained and can be copied to a machine without checking out
the full Fracto stack. Output is written beside it under `runtime/benchmarks/`.

Defaults: 12 observations at approximately five-second spacing, then a three-second
single-thread SHA-256 probe. Use `-CpuProbeSeconds 0` for passive measurements.
Use the same sample settings on both machines and record comparable workloads.
For example, `-SampleCount 60 -IntervalSeconds 5` provides a longer baseline.
Sampling overruns are reflected in timestamps rather than hidden; the HTTP timeout
is one second per probe. CPU probe measurements are separate from passive samples.

The report allowlists OS/CPU/GPU model and capacity fields, fixed-disk capacity,
CPU utilization, available RAM, memory page-in rate, aggregate Node working sets,
and loopback Fracto health/readiness response times. It excludes host/user names,
serials, network addresses, process command lines, credentials and response bodies.
Labels must be non-personal. Only the standard local main ports 3001/3101 are
probed; override with `-MainPorts 3001` or a configured local main port. HTTP
responses do not independently verify that a listener is Fracto. The script
never connects to another machine or uploads results.

## Interpretation

- Use minimum observed available RAM, together with typical workload behavior,
  to establish inference headroom. Installed RAM is not the inference budget.
- Compare CPU utilization and health latency under equivalent workload. This is
  an observation baseline, not a peak-capacity or inference benchmark.
- Missing/unreachable Fracto listeners are recorded as such; they do not establish
  that a machine can sustain its production workload. Health responses alone do
  not measure rendering, database throughput or actual browser interaction latency.
- GPU model/driver are inventoried, but dedicated VRAM remains unverified. WMI's
  [AdapterRAM field is uint32](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-videocontroller)
  and is unsuitable for establishing modern GPU memory capacity. Verify vendor
  memory/acceleration separately before selecting a GPU model profile.
- SHA-256 throughput measures one bounded CPU workload, not LLM inference speed.
  Model-specific cold/warm timings and tokens/second belong to step 2.

## Lab measurement status

Neither the 48 GB nor the 64 GB lab machine has been measured from this workspace yet. The currently
connected workspace host reports approximately 32 GB installed RAM and is not
assumed to be either target. The tool was validated there under PowerShell 7
with a 12-sample passive reference run, and under Windows PowerShell 5.1 with
a short run including the bounded CPU probe. These are tool-validation results,
not lab-server benchmarks. Automatic startup collection is implemented; the
target measurements remain pending their next standard Fracto launches. Step 1
remains incomplete until both target reports
are collected under documented typical workloads and GPU capacity is verified
where acceleration is to be used. Do not infer target-machine results from labels.
