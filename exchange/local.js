import { ArtifactError } from "./contracts.js";

/** Explicit projection from local jobs. Never serialize a job, session or model object. */
export const collect_local = (store, service, limit = 4) => {
  if (!service) return "unavailable";
  let jobs;
  try {
    service.available();
    jobs = service.protect(() => service.store.all());
  } catch {
    return "unavailable";
  }
  store.guard(() => store.prune_exports(new Set(jobs.map((job) => job.id))));
  let processed = 0;
  for (const job of jobs) {
    if (
      job.state !== "completed" ||
      store.guard(() => store.has_export(job.id))
    )
      continue;
    if (processed++ >= limit) break;
    let input, result;
    try {
      ({ input, result } = service.protect(() => ({
        input: service.store.read_artifact(job.input_hash),
        result: service.store.read_artifact(job.result_hash),
      })));
    } catch {
      return "unavailable";
    }
    try {
      store.publish(job.id, {
        contract_version: 1,
        operation: job.request.operation,
        request_created_at: job.created_at,
        completed_at: job.finished_at,
        input,
        result,
      });
    } catch (error) {
      if (
        !(error instanceof ArtifactError) ||
        ["DISK_PRESSURE", "EXCHANGE_UNAVAILABLE"].includes(error.code)
      )
        throw error;
      store.quarantine(store.node_id, "INVALID_ARTIFACT");
      store.reject_export(job.id);
    }
  }
  return "ready";
};
