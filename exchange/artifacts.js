import fs from "node:fs";
import path from "node:path";
import { hash } from "../inference/contracts.js";
import { write_bytes, secure_directory } from "../peers/files.js";
import { deny, digest_id, MAX_ARTIFACT_BYTES } from "./contracts.js";

export class ArtifactFiles {
  constructor(directory) {
    this.directory = directory;
    secure_directory(directory);
  }
  read(digest) {
    if (!digest_id(digest)) deny("EXCHANGE_CORRUPT", 503);
    const filename = path.join(this.directory, `${digest}.json`);
    const stat = fs.lstatSync(filename);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > MAX_ARTIFACT_BYTES
    )
      deny("EXCHANGE_CORRUPT", 503);
    const bytes = fs.readFileSync(filename);
    if (hash(bytes) !== digest) deny("EXCHANGE_CORRUPT", 503);
    return bytes;
  }
  write(bytes) {
    const digest = hash(bytes);
    const filename = path.join(this.directory, `${digest}.json`);
    try {
      write_bytes(filename, bytes, { initial: true });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    this.read(digest);
    return digest;
  }
  prune(referenced) {
    for (const file of fs.readdirSync(this.directory, {
      withFileTypes: true,
    })) {
      if (
        file.isFile() &&
        (/^[a-f0-9]{64}\.json$/.test(file.name) ||
          /^[a-f0-9-]{36}\.tmp$/.test(file.name)) &&
        !referenced.has(file.name)
      )
        fs.unlinkSync(path.join(this.directory, file.name));
    }
  }
}
