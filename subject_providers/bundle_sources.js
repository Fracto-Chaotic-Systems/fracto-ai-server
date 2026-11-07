import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

export class KnowledgeBundleError extends Error {
  constructor(code) {
    super(code);
    this.name = "KnowledgeBundleError";
    this.code = code;
  }
}
export const bundle_fail = (code) => {
  throw new KnowledgeBundleError(code);
};
export const digest = (value) =>
  createHash("sha256").update(value).digest("hex");

/** Reject links and non-regular sources before opening a bounded file snapshot. */
export const read_source_file = (root, relative, maximum) => {
  let handle;
  try {
    const root_stat = fs.lstatSync(root);
    if (!root_stat.isDirectory() || root_stat.isSymbolicLink())
      bundle_fail("INVALID_BUNDLE_SOURCE");
    const base = fs.realpathSync(root);
    let target = base;
    const parts = relative.split("/");
    if (
      !parts.length ||
      parts.some(
        (part) => !part || [".", ".."].includes(part) || /[\\:]/.test(part),
      )
    )
      bundle_fail("INVALID_BUNDLE_SOURCE");
    for (let index = 0; index < parts.length; index++) {
      target = path.join(target, parts[index]);
      const stat = fs.lstatSync(target);
      if (
        stat.isSymbolicLink() ||
        (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())
      )
        bundle_fail("INVALID_BUNDLE_SOURCE");
    }
    const resolved = fs.realpathSync(target),
      within = path.relative(base, resolved);
    if (!within || within.startsWith("..") || path.isAbsolute(within))
      bundle_fail("INVALID_BUNDLE_SOURCE");
    const expected = fs.lstatSync(resolved, { bigint: true });
    if (!expected.isFile() || expected.isSymbolicLink())
      bundle_fail("INVALID_BUNDLE_SOURCE");
    handle = fs.openSync(
      resolved,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    const before = fs.fstatSync(handle, { bigint: true });
    if (before.dev !== expected.dev || before.ino !== expected.ino)
      bundle_fail("BUNDLE_SOURCE_CHANGED");
    if (!before.isFile() || before.size > BigInt(maximum))
      bundle_fail("BUNDLE_SOURCE_TOO_LARGE");
    const buffer = Buffer.alloc(maximum + 1);
    let size = 0,
      count;
    while (
      size < buffer.length &&
      (count = fs.readSync(handle, buffer, size, buffer.length - size, null))
    )
      size += count;
    if (size > maximum) bundle_fail("BUNDLE_SOURCE_TOO_LARGE");
    const after = fs.fstatSync(handle, { bigint: true });
    if (
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      BigInt(size) !== after.size
    )
      bundle_fail("BUNDLE_SOURCE_CHANGED");
    return buffer.subarray(0, size);
  } catch (error) {
    if (error instanceof KnowledgeBundleError) throw error;
    bundle_fail("BUNDLE_SOURCE_UNAVAILABLE");
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
};

/** Only commit hashes/source-byte equality are retained; no authors or remotes. */
export const source_provenance = (root, relative, source_digest) => {
  const git = (args, maxBuffer = 1024) =>
    spawnSync(
      "git",
      ["-c", `safe.directory=${path.resolve(root)}`, "-C", root, ...args],
      {
        shell: false,
        windowsHide: true,
        timeout: 5000,
        maxBuffer,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
  const head = git(["rev-parse", "HEAD"]);
  const revision =
    head.status === 0 ? head.stdout.toString("utf8").trim() : null;
  if (!revision || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision))
    return { repository_revision: null, source_state: "unknown" };
  const tracked = git(["ls-files", "--error-unmatch", "--", relative]);
  if (tracked.status !== 0)
    return tracked.status === 1
      ? { repository_revision: revision, source_state: "unversioned" }
      : { repository_revision: null, source_state: "unknown" };
  const committed = git(["show", `${revision}:${relative}`], 1048577);
  return {
    repository_revision: revision,
    source_state:
      committed.status === 0 && digest(committed.stdout) === source_digest
        ? "committed"
        : "modified",
  };
};
