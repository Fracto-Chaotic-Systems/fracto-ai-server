/** Internal pure validation helpers; no filesystem or execution capabilities. */
export class SubjectProviderError extends Error {
  constructor(code) {
    super(code);
    this.name = "SubjectProviderError";
    this.code = code;
  }
}
export const fail = (code = "INVALID_SUBJECT_PROVIDER") => {
  throw new SubjectProviderError(code);
};
export const object = (value, fields) => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.keys(value).length !== fields.length ||
    !fields.every((key) => Object.hasOwn(value, key))
  )
    fail();
};
export const label = (value, maximum = 32) => {
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value)
  )
    fail();
};
export const version = (value) => {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})$/.test(
      value,
    )
  )
    fail();
};
export const list = (value, maximum, minimum = 1) => {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum)
    fail();
};
export const unique = (values) => {
  if (new Set(values).size !== values.length) fail();
};
export const bytes = (value) => Buffer.byteLength(value, "utf8");
export const integer = (value, maximum) => {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) fail();
};
export const safe_path = (value) => {
  if (
    typeof value !== "string" ||
    value.length > 240 ||
    !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$/.test(
      value,
    ) ||
    !/\.(md|txt|json|js|jsx|ts|tsx|yaml|yml)$/.test(value)
  )
    fail();
  const blocked = new Set([
    "node_modules",
    "runtime",
    "logs",
    "config",
    "dist",
    "coverage",
    "secrets",
    "credentials",
  ]);
  const parts = value.split("/");
  if (
    parts.some(
      (part) =>
        blocked.has(part.toLowerCase()) ||
        part.endsWith(".") ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    )
  )
    fail();
};
const sort = (value) =>
  Array.isArray(value)
    ? value.map(sort)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, sort(value[key])]),
        )
      : value;
export const canonical = (value) => JSON.stringify(sort(value));
export const valid_text = (text) =>
  typeof text === "string" &&
  !!text.trim() &&
  Buffer.from(text, "utf8").toString("utf8") === text &&
  !Array.from(text).some((character) => {
    const code = character.codePointAt(0);
    return code === 127 || (code < 32 && ![9, 10, 13].includes(code));
  });

/** Supported structural check: ATX headings outside fenced code blocks. */
export const headings = (text) => {
  const titles = new Set();
  let fence = null;
  for (const line of text.split(/\r?\n/)) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (
        marker[1][0] === fence[0] &&
        marker[1].length >= fence.length &&
        !marker[2].trim()
      )
        fence = null;
      continue;
    }
    if (fence) continue;
    const heading = line.match(/^ {0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/);
    if (heading) titles.add(heading[1].trim());
  }
  return titles;
};
