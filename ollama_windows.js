import path from "node:path";
import { spawn } from "node:child_process";

/** Bootstrap an independent Windows-local engine; never wait for downloads. */
export const start_windows_ollama = ({
  platform = process.platform,
  environment = process.env,
  spawn_process = spawn,
  on_error = () =>
    console.warn(
      "Windows-local Ollama bootstrap unavailable; Fracto continues",
    ),
} = {}) => {
  if (
    platform !== "win32" ||
    environment.FRACTO_OLLAMA_ENABLED === "false" ||
    (environment.FRACTO_AI_ENGINE && environment.FRACTO_AI_ENGINE !== "ollama")
  )
    return false;
  try {
    const child = spawn_process(
      "powershell.exe",
      [
        "-NoProfile",
        "-File",
        path.join(import.meta.dirname, "start_ollama_windows.ps1"),
      ],
      {
        windowsHide: true,
        stdio: "ignore",
        env: environment,
      },
    );
    child.once("error", on_error);
    child.once("exit", (code) => {
      if (code !== 0) on_error();
    });
    return true;
  } catch {
    on_error();
    return false;
  }
};
