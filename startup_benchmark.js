import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { StartupObserver } from "./startup_observer.js";

const index = process.argv.indexOf("--port");
const port = Number(index < 0 ? 3001 : process.argv[index + 1]);
if (
  process.platform !== "win32" ||
  !Number.isInteger(port) ||
  port < 1 ||
  port > 65535
)
  process.exit(1);
const directory = path.join(import.meta.dirname, "runtime", "benchmarks");
fs.mkdirSync(directory, { recursive: true });
const label = `main-${port}`;
const report_name = (id) => `windows-baseline-${label}-${id}.json`;
const status_file = path.join(
  directory,
  `startup-benchmark-${port}.status.json`,
);

const atomic_json = (file, value) => {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
  fs.renameSync(temporary, file);
};
const load_report = (id) => {
  try {
    const value = JSON.parse(
      fs
        .readFileSync(path.join(directory, report_name(id)), "utf8")
        .replace(/^\uFEFF/, ""),
    );
    return (
      value.schema_version === 1 &&
      value.fracto_startup_id === id &&
      value.samples?.length >= 3
    );
  } catch {
    return false;
  }
};
const prune = () => {
  const pattern = new RegExp(
    `^windows-baseline-${label}-(?:[a-f0-9-]{36}|legacy-[0-9]+)(?:\\.inventory)?\\.json$`,
    "i",
  );
  const groups = new Map();
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !pattern.test(entry.name)) continue;
    const key = entry.name.replace(/\.inventory\.json$/, ".json");
    const group = groups.get(key) || { files: [], time: 0 };
    group.files.push(entry.name);
    group.time = Math.max(
      group.time,
      fs.statSync(path.join(directory, entry.name)).mtimeMs,
    );
    groups.set(key, group);
  }
  for (const group of [...groups.values()]
    .sort((a, b) => b.time - a.time)
    .slice(30)) {
    for (const name of group.files) fs.unlinkSync(path.join(directory, name));
  }
};
const read_health = async () => {
  const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
    signal: AbortSignal.timeout(2000),
  });
  if (!response.ok) return null;
  // Ignore server_name, build_info and other fields; never persist entire responses.
  const body = await response.json();
  return {
    contract_version: body.contract_version,
    startup_id: body.startup_id,
    uptime_seconds: body.uptime_seconds,
    services: body.services,
  };
};
const collect = (id, signal) =>
  new Promise((resolve, reject) => {
    const args = [
      "-NoProfile",
      "-File",
      path.join(import.meta.dirname, "benchmark_windows.ps1"),
      "-NodeLabel",
      label,
      "-MainPorts",
      String(port),
      "-ReadyPort",
      String(port),
      "-RunId",
      id,
      "-SettleSeconds",
      "30",
      "-CpuProbeSeconds",
      "0",
    ];
    if (!id.startsWith("legacy-")) args.push("-ExpectedStartupId", id);
    const child = spawn("powershell.exe", args, {
      windowsHide: true,
      stdio: "ignore",
    });
    const abort = () => child.kill();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timeout = setTimeout(abort, 20 * 60 * 1000);
    const finish = (success) => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      if (success && !signal.aborted && load_report(id))
        resolve(report_name(id));
      else reject(new Error("Collection failed"));
    };
    child.once("error", () => finish(false));
    child.once("exit", (code) => finish(code === 0));
  });
const observer = new StartupObserver({
  read_health,
  collect,
  has_report: load_report,
  read_state: (id) => {
    try {
      const saved = JSON.parse(fs.readFileSync(status_file, "utf8"));
      return saved.startup_id === id
        ? { attempts: saved.attempt, retry_at: saved.retry_at }
        : null;
    } catch {
      return null;
    }
  },
  on_state: (state) => {
    atomic_json(status_file, {
      schema_version: 1,
      main_port: port,
      startup_id: state.id,
      phase: state.state,
      attempt: state.attempts,
      retry_at: state.retry_at,
      updated_at_utc: new Date().toISOString(),
      report_file:
        state.report_file ||
        (state.state === "completed" ? report_name(state.id) : null),
      error: state.error || null,
    });
    prune();
  },
});
let ticking = false;
const tick = async () => {
  if (ticking) return;
  ticking = true;
  try {
    await observer.tick();
  } catch {
    /* Observation failures never affect Fracto; a later poll retries. */
  } finally {
    ticking = false;
  }
};
const timer = setInterval(tick, 5000);
await tick();
for (const name of ["SIGINT", "SIGTERM"])
  process.once(name, async () => {
    clearInterval(timer);
    await observer.stop();
  });
