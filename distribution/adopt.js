import { fail } from "./contracts.js";

export const adopt_knowledge = (
  catalog,
  checksum,
  knowledge,
  source,
  expected = null,
) => {
  const label = (value) =>
    typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,79}$/.test(value);
  if (!label(source) || (expected !== null && !label(expected)))
    fail("INVALID_ADOPTION");
  const item = catalog.get(checksum);
  if (item.record.kind !== "knowledge") fail("INVALID_ADOPTION");
  const target = `knowledge:${source}`,
    revision = `peer-${checksum}`;
  const current = knowledge.current(source)?.current_revision ?? null;
  if (current !== expected && current !== revision)
    fail("CURRENT_REVISION_CONFLICT");
  const intent = catalog.begin_adoption(checksum, target, expected);
  if (intent.state !== "completed") {
    knowledge.put(source, revision, item.record.payload.text, expected);
    catalog.finish_adoption(checksum, target);
  }
  if (
    knowledge.get(source, revision).digest !==
    item.record.payload.content_digest
  )
    fail("CORRUPT_ADOPTION");
  return {
    source,
    revision,
    record_digest: checksum,
    origin: item.record.origin,
    immediate_sender: item.immediate_sender,
    evidence_only: true,
  };
};
export const adopt_skill = (catalog, checksum, registry) => {
  const item = catalog.get(checksum);
  if (item.record.kind !== "skill") fail("INVALID_ADOPTION");
  const definition = item.record.payload.definition,
    target = `skill:${definition.skill_id}:${definition.version}`;
  const intent = catalog.begin_adoption(checksum, target, null);
  if (intent.state !== "completed") {
    registry.publish(definition);
    catalog.finish_adoption(checksum, target);
  }
  if (
    registry.get(definition.skill_id, definition.version).digest !==
    item.record.payload.definition_digest
  )
    fail("CORRUPT_ADOPTION");
  return {
    id: definition.skill_id,
    version: definition.version,
    record_digest: checksum,
    activation_changed: false,
    evaluation_imported: false,
  };
};
