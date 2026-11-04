import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

export class PeerError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
export const reject = (code = "PEER_CONFIGURATION_ERROR") => {
  throw new PeerError(code);
};
export const secure_directory = (directory) => {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(directory).isSymbolicLink()) reject();
  if (process.platform === "win32") {
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(import.meta.dirname, "../inference/secure_directory.ps1"),
        "-Directory",
        directory,
      ],
      { windowsHide: true, stdio: "ignore", timeout: 15000 },
    );
    if (result.status !== 0) reject();
  } else {
    fs.chmodSync(directory, 0o700);
    if ((fs.statSync(directory).mode & 0o077) !== 0) reject();
  }
};
export const read_json = (filename, limit = 262144) => {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) reject();
  return JSON.parse(fs.readFileSync(filename, "utf8"));
};
export const write_bytes = (filename, bytes, { initial = false } = {}) => {
  const temporary = path.join(path.dirname(filename), `${randomUUID()}.tmp`);
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    // Atomic initial publication must not replace another process's identity.
    if (initial) fs.linkSync(temporary, filename);
    else fs.renameSync(temporary, filename);
    if (process.platform !== "win32") {
      const directory = fs.openSync(path.dirname(filename), "r");
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
    }
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
};
export const write_json = (filename, value, options = {}) =>
  write_bytes(
    filename,
    Buffer.from(JSON.stringify(value, null, 2) + "\n"),
    options,
  );
