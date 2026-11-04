/** Observe process generations, not individual readiness fluctuations. */
export class StartupObserver {
  constructor({
    read_health,
    collect,
    has_report = () => false,
    read_state = () => null,
    on_state = () => {},
    now = Date.now,
    retry_ms = 60000,
    max_attempts = 3,
  }) {
    Object.assign(this, {
      read_health,
      collect,
      has_report,
      read_state,
      on_state,
      now,
      retry_ms,
      max_attempts,
    });
    this.current = null;
    this.active = null;
    this.polling = false;
    this.stopped = false;
  }

  identify(health) {
    if (
      health?.contract_version !== 1 ||
      !health.services ||
      Array.isArray(health.services) ||
      typeof health.services !== "object" ||
      !Number.isFinite(health.uptime_seconds) ||
      health.uptime_seconds < 0
    )
      return null;
    if (health.startup_id != null) {
      return /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(
        health.startup_id,
      )
        ? health.startup_id
        : null;
    }
    // Migration support for already running main servers without startup_id.
    const epoch = Math.round(this.now() / 1000 - health.uptime_seconds);
    if (
      this.current?.legacy_epoch != null &&
      Math.abs(epoch - this.current.legacy_epoch) <= 5
    )
      return this.current.id;
    return `legacy-${epoch}`;
  }

  publish(state, extra = {}) {
    Object.assign(this.current, { state }, extra);
    try {
      this.on_state({ ...this.current });
    } catch {
      /* Status storage failure must not stop the observer or Fracto. */
    }
  }

  async tick() {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      const health = await this.read_health().catch(() => null);
      if (this.stopped) return;
      const id = this.identify(health);
      if (!id) return;
      if (this.current?.id !== id) {
        this.active?.controller.abort();
        this.active = null;
        this.current = {
          id,
          attempts: 0,
          state: "waiting",
          retry_at: 0,
          legacy_epoch: id.startsWith("legacy-") ? Number(id.slice(7)) : null,
        };
        const saved = this.read_state(id);
        if (Number.isInteger(saved?.attempts) && saved.attempts >= 0) {
          this.current.attempts = Math.min(saved.attempts, this.max_attempts);
          this.current.retry_at = Number.isFinite(saved.retry_at)
            ? saved.retry_at
            : 0;
        }
        if (this.has_report(id)) this.publish("completed");
        else if (this.current.attempts >= this.max_attempts)
          this.publish("failed", { error: "collection_failed" });
        else this.publish("inventory_and_readiness");
      }
      if (
        this.active ||
        this.current.state === "completed" ||
        this.current.attempts >= this.max_attempts ||
        this.current.retry_at > this.now()
      )
        return;
      this.current.attempts++;
      const run = { id, controller: new AbortController() };
      this.active = run;
      this.publish("inventory_and_readiness");
      run.done = Promise.resolve()
        .then(() => this.collect(id, run.controller.signal))
        .then(
          (report) => {
            if (this.active === run && !this.stopped)
              this.publish("completed", {
                report_file: report,
                error: null,
                retry_at: 0,
              });
          },
          () => {
            if (this.active === run && !this.stopped)
              this.publish(
                this.current.attempts >= this.max_attempts
                  ? "failed"
                  : "retry_wait",
                {
                  retry_at: this.now() + this.retry_ms,
                  error: "collection_failed",
                },
              );
          },
        )
        .finally(() => {
          if (this.active === run) this.active = null;
        });
    } finally {
      this.polling = false;
    }
  }

  async stop() {
    this.stopped = true;
    this.active?.controller.abort();
    await this.active?.done;
  }
}
