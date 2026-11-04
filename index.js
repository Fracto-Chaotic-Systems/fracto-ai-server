import { create_app, configured_port, SERVICE_NAME } from "./app.js";

const port = configured_port();
const server = create_app().listen(port, "0.0.0.0", () => {
  console.log(`${SERVICE_NAME} foundation is ready on port ${port}`);
});
server.on("error", () => {
  console.error(`${SERVICE_NAME} could not open its listener`);
  process.exitCode = 1;
});

let stopping = false;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  console.log(`${SERVICE_NAME} stopping`);
  const deadline = setTimeout(() => {
    server.closeAllConnections();
    process.exitCode = 1;
  }, 5000);
  deadline.unref();
  server.close(() => clearTimeout(deadline));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
