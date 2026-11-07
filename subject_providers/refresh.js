import { read_ui_bundle } from "./reconcile.js";

export const REFRESH_INTERVAL_MS = 60000;

/** Consume only the fixed prebuilt artifact; never extract source or invoke skills/models. */
export const start_app_reference_refresh = (
  store,
  environment = process.env,
  {
    read_bundle = read_ui_bundle,
    schedule = setInterval,
    unschedule = clearInterval,
    report_failure = () =>
      console.error("fracto-ai-server app reference refresh unavailable"),
  } = {},
) => {
  const setting = environment.FRACTO_AI_APP_REFERENCE_REFRESH ?? "true";
  let last = {
    state: setting === "false" ? "disabled" : "pending",
    changed: false,
  };
  let stopped = false,
    timer;
  const update = (result) => {
    if (result.state === "unavailable" && last.state !== "unavailable")
      report_failure();
    last = result;
    return { ...last };
  };
  const run = () => {
    if (stopped || setting === "false") return { ...last };
    if (setting !== "true")
      return update({ state: "unavailable", changed: false });
    try {
      return update(store.refresh_bundle(read_bundle()));
    } catch {
      // Retain the last complete publication. Do not expose filesystem/parser details.
      return update({ state: "unavailable", changed: false });
    }
  };
  const close = () => {
    if (stopped) return;
    stopped = true;
    if (timer !== undefined) unschedule(timer);
    last = { state: "stopped", changed: false };
  };
  if (setting !== "false") {
    run();
    if (setting === "true") {
      timer = schedule(run, REFRESH_INTERVAL_MS);
      timer?.unref?.();
    }
  }
  return { run, close, status: () => ({ ...last }) };
};
