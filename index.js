import {
  create_app,
  configured_port,
  configured_host,
  SERVICE_NAME,
} from "./app.js";
import { start_windows_ollama } from "./ollama_windows.js";
import { create_inference_runtime } from "./inference/runtime.js";
import { create_peer_runtime } from "./peers/runtime.js";

const port = configured_port();
const host = configured_host();
start_windows_ollama();
const runtime = create_inference_runtime();
const peers = create_peer_runtime(process.env, {
  source: () => runtime.service,
});
let closing;
const close_runtimes = () => {
  closing ??= Promise.all([runtime.service?.close(), peers.close()]);
  return closing;
};
const server = create_app({
  inference: runtime.service,
  engine_status: runtime.engine_status,
  peer_status: () => peers.status(),
  get_exchange: () => peers.exchange,
  get_delegation: () => peers.delegation,
}).listen(port, host, () => {
  console.log(`${SERVICE_NAME} foundation is ready on port ${port}`);
});
server.on("error", () => {
  console.error(`${SERVICE_NAME} could not open its listener`);
  process.exitCode = 1;
  // A second listener must not keep a failed HTTP service alive indefinitely.
  close_runtimes().catch(() => {});
});

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  console.log(`${SERVICE_NAME} stopping`);
  const deadline = setTimeout(() => {
    server.closeAllConnections();
    process.exitCode = 1;
  }, 5000);
  deadline.unref();
  server.close(() => clearTimeout(deadline));
  await close_runtimes();
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
