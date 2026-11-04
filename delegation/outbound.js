import {
  ERRORS,
  error_code,
  fail,
  receipt_contract,
  terminal_remote,
  wire_request,
} from "./contracts.js";

const finish = (row, state, error = null) => {
  row.state = state;
  row.error = error;
  row.reconciling = false;
  row.finished_at = Date.now();
};
/** Only prepared work may POST once. All ambiguous work uses read-only reconciliation. */
export const perform = async (runtime, row, signal) => {
  let posting = false;
  const peer = runtime
    .peers()
    .find(
      (entry) =>
        entry.node_id === row.peer_id &&
        !entry.revoked &&
        entry.outbound_scopes.includes("inference:delegate"),
    );
  try {
    if (!peer) fail("PEER_NOT_ALLOWED", 403);
    let route = `/peer/v1/delegations/${row.id}`,
      method = "GET",
      body;
    if (row.state === "prepared") {
      const remaining_ms = row.deadline_at - Date.now();
      if (remaining_ms < 100) {
        finish(row, "expired", "DEADLINE_EXCEEDED");
        runtime.store.save(row);
        return;
      }
      body = wire_request(
        {
          contract_version: 1,
          origin_node_id: row.origin_node_id,
          origin_request_id: row.id,
          origin_idempotency_key: row.idempotency_key,
          hop_count: 1,
          created_at: row.created_at,
          deadline_at: row.deadline_at,
          remaining_ms,
          expected: row.expected,
          request: {
            operation: row.request.operation,
            input: row.request.input,
            max_output_tokens: row.request.max_output_tokens,
          },
        },
        row.origin_node_id,
      );
      route = "/peer/v1/delegations";
      method = "POST";
      row.state = "submitting";
      runtime.store.save(row);
      posting = true;
    } else if (row.cancel_requested) {
      route += "/cancel";
      method = "POST";
    }
    const response = await runtime.request({
      identity: runtime.identity(),
      peer,
      signal,
      route,
      method,
      body,
    });
    if (signal.aborted) fail("CANCELLED", 503);
    if (
      response.status !== undefined &&
      ![200, 202].includes(response.status)
    ) {
      const value = response.value;
      if (
        posting &&
        value?.contract_version === 1 &&
        value.acceptance === "rejected" &&
        Object.keys(value).length === 3 &&
        ERRORS.has(value.error)
      )
        finish(row, "rejected", value.error);
      else if (
        posting &&
        [403, 429].includes(response.status) &&
        value?.acceptance !== "unknown"
      ) {
        finish(
          row,
          "rejected",
          response.status === 403 ? "SCOPE_DENIED" : "PEER_BUSY",
        );
      } else
        fail(
          value?.error === "DELEGATION_NOT_FOUND"
            ? "DELEGATION_NOT_FOUND"
            : "OUTCOME_UNKNOWN",
          503,
        );
    } else {
      const receipt = receipt_contract(response.value, row, row.peer_id);
      row.receipt = receipt;
      if (terminal_remote(receipt.state))
        finish(row, receipt.state, receipt.error);
      else {
        row.state = row.cancel_requested ? "cancelling" : "accepted";
        row.reconciling = true;
        row.error = null;
      }
    }
  } catch (error) {
    if (row.state === "prepared")
      finish(
        row,
        error.code === "DEADLINE_EXCEEDED" ? "expired" : "rejected",
        error_code(error),
      );
    else {
      row.state = "unknown";
      row.reconciling = true;
      row.error = error_code(error);
    }
  }
  // A local cancellation may arrive while the peer acknowledgement is in flight.
  const current = runtime.store.get(row.id);
  row.cancel_requested ||= current.cancel_requested;
  if (row.cancel_requested && row.reconciling && row.state === "accepted")
    row.state = "cancelling";
  row.next_at = Date.now() + runtime.query_interval_ms;
  runtime.store.save(row);
};
