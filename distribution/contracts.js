import { randomUUID, createHash } from "node:crypto";
import { uuid } from "../inference/contracts.js";
import { normalize_definition, canonical, hash } from "../skills/contracts.js";

export const MAX_BYTES = 196608;
export const kinds = Object.freeze({
  knowledge: "knowledge:exchange",
  skill: "skills:exchange",
});
export class DistributionError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
export const fail = (code = "INVALID_DISTRIBUTION", status) => {
  throw new DistributionError(code, status);
};
export const exact = (value, keys) => {
  if (
    !value ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    fail();
};
export const digest = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const label = (value) =>
  typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,79}$/.test(value);
export const bytes_hash = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
export const origin = (value) => {
  exact(value, ["node_id", "epoch", "sequence"]);
  if (
    !uuid(value.node_id) ||
    !uuid(value.epoch) ||
    !integer(value.sequence) ||
    value.sequence < 1
  )
    fail();
  return {
    node_id: value.node_id,
    epoch: value.epoch,
    sequence: value.sequence,
  };
};
export const payload = (kind, value) => {
  if (kind === "knowledge") {
    exact(value, ["source", "revision", "content_digest", "text"]);
    if (
      !label(value.source) ||
      !label(value.revision) ||
      !digest(value.content_digest) ||
      typeof value.text !== "string" ||
      !value.text.trim() ||
      Buffer.byteLength(value.text) > 65536 ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value.text) ||
      Buffer.from(value.text).toString("utf8") !== value.text ||
      bytes_hash(Buffer.from(value.text)) !== value.content_digest
    )
      fail();
    return {
      source: value.source,
      revision: value.revision,
      content_digest: value.content_digest,
      text: value.text,
    };
  }
  if (kind === "skill") {
    exact(value, ["definition", "definition_digest"]);
    let definition;
    try {
      definition = normalize_definition(value.definition);
    } catch {
      fail("INVALID_DISTRIBUTION");
    }
    if (hash(canonical(definition)) !== value.definition_digest) fail();
    return { definition, definition_digest: value.definition_digest };
  }
  fail();
};
export const record = (value) => {
  exact(value, ["contract_version", "kind", "origin", "payload"]);
  if (value.contract_version !== 1 || !Object.hasOwn(kinds, value.kind)) fail();
  return {
    contract_version: 1,
    kind: value.kind,
    origin: origin(value.origin),
    payload: payload(value.kind, value.payload),
  };
};
export const encode = (value) => {
  const bytes = Buffer.from(canonical(record(value)));
  if (bytes.length > MAX_BYTES) fail();
  return bytes;
};
export const parse = (bytes) => {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_BYTES) fail();
  let value;
  try {
    value = record(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
  } catch {
    fail();
  }
  if (!encode(value).equals(bytes)) fail();
  return value;
};
export const page_contract = (value, kind, cursor) => {
  exact(value, [
    "contract_version",
    "kind",
    "epoch",
    "entries",
    "next_cursor",
    "has_more",
  ]);
  if (
    value.contract_version !== 1 ||
    value.kind !== kind ||
    !uuid(value.epoch) ||
    !Array.isArray(value.entries) ||
    value.entries.length > 4 ||
    typeof value.has_more !== "boolean" ||
    !integer(value.next_cursor) ||
    value.next_cursor < cursor
  )
    fail("INVALID_DISTRIBUTION_MANIFEST");
  let last = cursor;
  for (const entry of value.entries) {
    exact(entry, ["sequence", "digest", "bytes", "origin"]);
    if (
      !integer(entry.sequence) ||
      entry.sequence <= last ||
      !digest(entry.digest) ||
      !integer(entry.bytes) ||
      entry.bytes < 1 ||
      entry.bytes > MAX_BYTES
    )
      fail("INVALID_DISTRIBUTION_MANIFEST");
    origin(entry.origin);
    last = entry.sequence;
  }
  if (value.entries.length && value.next_cursor !== last)
    fail("INVALID_DISTRIBUTION_MANIFEST");
  if (value.has_more && !value.entries.length)
    fail("INVALID_DISTRIBUTION_MANIFEST");
  return value;
};
export const fresh_epoch = randomUUID;
