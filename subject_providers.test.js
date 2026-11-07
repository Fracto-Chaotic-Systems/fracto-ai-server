import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTRACT_VERSION,
  LIMITS,
  REPOSITORIES,
  SubjectProviderError,
  validate_provider,
  validate_documents,
  provider_digest,
  knowledge_source_id,
} from "./subject_providers/contracts.js";

const fixture = () => ({
  contract_version: 1,
  provider_id: "ui-features",
  subject_id: "application-ui",
  extractor: { id: "ui-catalog", version: "1.0.0" },
  sources: [
    { id: "catalog", repository: "ui", path: "src/features/catalog.json" },
  ],
  documents: [
    {
      id: "navigation",
      source_ids: ["catalog"],
      format: "markdown",
      validation: {
        profile: "reference-text-v1",
        required_sections: ["Purpose", "Permissions"],
      },
    },
  ],
  limits: {
    source_bytes: 262144,
    total_source_bytes: 1048576,
    document_bytes: 65536,
    total_document_bytes: 262144,
  },
});
const output = () => [
  {
    id: "navigation",
    source_ids: ["catalog"],
    text: "# Purpose\nBrowse the app.\n## Permissions\nAdministrator access.",
  },
];
const invalid = (operation, code = "INVALID_SUBJECT_PROVIDER") =>
  assert.throws(
    operation,
    (error) =>
      error instanceof SubjectProviderError &&
      error.message === code &&
      error.code === code,
  );

test("providers declare multiple subjects without requiring existing files or registered extractors", () => {
  const ui = fixture();
  assert.equal(CONTRACT_VERSION, 1);
  assert.ok(REPOSITORIES.includes("main"));
  assert.deepEqual(validate_provider(ui), ui);
  const architecture = fixture();
  Object.assign(architecture, {
    provider_id: "architecture",
    subject_id: "service-ownership",
  });
  architecture.extractor = { id: "reference-documents", version: "2.1.0" };
  architecture.sources[0] = {
    id: "catalog",
    repository: "main",
    path: "docs/future-reference.md",
  };
  assert.equal(validate_provider(architecture).provider_id, "architecture");
});

test("normalization is detached and fingerprints ignore declaration/property ordering", () => {
  const first = fixture();
  first.sources.push({ id: "app", repository: "ui", path: "src/App.jsx" });
  first.documents[0].source_ids.push("app");
  first.documents.push({
    ...structuredClone(first.documents[0]),
    id: "accounts",
  });
  const second = Object.fromEntries(
    Object.entries(structuredClone(first)).reverse(),
  );
  second.sources.reverse();
  second.documents.reverse();
  second.documents.forEach((document) => document.source_ids.reverse());
  assert.equal(provider_digest(first), provider_digest(second));
  const normalized = validate_provider(first);
  normalized.sources[0].path = "changed.md";
  assert.equal(first.sources[0].path, "src/features/catalog.json");
  second.extractor.version = "1.0.1";
  assert.notEqual(provider_digest(first), provider_digest(second));
});

test("declarations reject unknown fields, invalid identities, versions and executable selectors", () => {
  const changes = [
    (p) => {
      p.contract_version = 2;
    },
    (p) => {
      p.provider_id = "../../escape";
    },
    (p) => {
      p.provider_id = "x".repeat(33);
    },
    (p) => {
      p.subject_id = "x".repeat(41);
    },
    (p) => {
      p.extractor.version = "01.0.0";
    },
    (p) => {
      p.extractor.version = "1.0.0-beta";
    },
    (p) => {
      p.extractor.version = "1000.0.0";
    },
    (p) => {
      p.extractor.command = "run";
    },
    (p) => {
      p.extractor.id = "file:///extractor.js";
    },
    (p) => {
      p.permissions = ["write"];
    },
    (p) => {
      p.sources[0].repository = "https://remote.invalid";
    },
    (p) => {
      p.documents[0].validation.profile = "execute-js";
    },
    (p) => {
      p.documents[0].validation.regex = ".*";
    },
    (p) => {
      p.documents[0].validation.required_sections = ["line\nbreak"];
    },
    (p) => {
      p.documents[0].format = "html";
    },
  ];
  for (const change of changes) {
    const provider = fixture();
    change(provider);
    invalid(() => validate_provider(provider));
  }
  for (const provider of [null, [], {}, new Date()])
    invalid(() => validate_provider(provider));
});

test("source paths are exact portable declarations excluding private/runtime locations", () => {
  for (const path of [
    "../file.md",
    "src/../file.md",
    "/tmp/file.md",
    "C:/file.md",
    "C:\\file.md",
    "//server/file.md",
    "https://site/file.md",
    "src/*.jsx",
    "src/%2e%2e/file.md",
    ".env",
    ".env.example",
    ".git/config.json",
    ".aws/credentials.json",
    "config/users.json",
    "runtime/history.md",
    "logs/error.txt",
    "node_modules/package.json",
    "dist/app.js",
    "secrets/keys.json",
    "credentials/token.json",
    "src/nul.txt",
    "con/file.md",
    "src./file.md",
    "src/file.md?x=1",
  ]) {
    const provider = fixture();
    provider.sources[0].path = path;
    invalid(() => validate_provider(provider));
  }
  for (const path of [
    "README.md",
    "src/App.jsx",
    "src/settings/AdminSettings.jsx",
    "docs/ui-help.txt",
    "compose.yaml",
  ]) {
    const provider = fixture();
    provider.sources[0].path = path;
    assert.ok(validate_provider(provider));
  }
});

test("source/document identities, references and validation rules must be consistent", () => {
  const changes = [
    (p) => {
      p.sources.push({ ...p.sources[0] });
    },
    (p) => {
      p.sources.push({
        ...p.sources[0],
        id: "duplicate",
        path: "src/features/CATALOG.json",
      });
    },
    (p) => {
      p.documents.push(structuredClone(p.documents[0]));
    },
    (p) => {
      p.documents[0].source_ids = ["missing"];
    },
    (p) => {
      p.documents[0].source_ids = ["catalog", "catalog"];
    },
    (p) => {
      p.documents[0].validation.required_sections = ["Purpose", "Purpose"];
    },
    (p) => {
      p.documents[0].format = "text";
    },
    (p) => {
      p.sources = [];
    },
    (p) => {
      p.documents = [];
    },
  ];
  for (const change of changes) {
    const provider = fixture();
    change(provider);
    invalid(() => validate_provider(provider));
  }
});

test("declaration bounds cannot exceed the existing knowledge document ceiling", () => {
  assert.equal(LIMITS.document_bytes, 65536);
  for (const value of [0, -1, 1.5, Infinity, NaN, 65537]) {
    const provider = fixture();
    provider.limits.document_bytes = value;
    invalid(() => validate_provider(provider));
  }
  const inconsistent = fixture();
  inconsistent.limits.total_document_bytes = 1;
  invalid(() => validate_provider(inconsistent));
  const too_many = fixture();
  too_many.sources = Array.from({ length: 65 }, (_, i) => ({
    id: `s-${i}`,
    repository: "main",
    path: `docs/${i}.md`,
  }));
  invalid(() => validate_provider(too_many));
  const oversized = fixture();
  oversized.documents = Array.from({ length: 64 }, (_, i) => ({
    ...structuredClone(oversized.documents[0]),
    id: `doc-${i}`,
    validation: {
      profile: "reference-text-v1",
      required_sections: Array.from(
        { length: 16 },
        (_, j) => `${j}-${"x".repeat(110)}`,
      ),
    },
  }));
  invalid(() => validate_provider(oversized));
});

test("knowledge source IDs are stable, bounded and unambiguous across providers", () => {
  const first = fixture();
  first.provider_id = "a-b";
  first.documents[0].id = "c";
  const second = fixture();
  second.provider_id = "a";
  second.documents[0].id = "b-c";
  assert.notEqual(
    knowledge_source_id(first, "c"),
    knowledge_source_id(second, "b-c"),
  );
  const maximum = fixture();
  maximum.provider_id = "p".repeat(32);
  maximum.documents[0].id = "d".repeat(32);
  const id = knowledge_source_id(maximum, maximum.documents[0].id);
  assert.equal(id.length, 72);
  assert.match(id, /^[a-z0-9][a-z0-9-]{0,79}$/);
  invalid(() => knowledge_source_id(first, "unknown"));
});

test("extractor output preserves exact text and rejects missing/undeclared documents or evidence", () => {
  const provider = fixture(),
    documents = output();
  assert.deepEqual(validate_documents(provider, documents), documents);
  const normalized = validate_documents(provider, documents);
  normalized[0].source_ids.push("local");
  assert.deepEqual(documents[0].source_ids, ["catalog"]);
  for (const bad of [
    [],
    [null],
    [{ ...documents[0], id: "other" }],
    [{ ...documents[0], source_ids: [] }],
    [{ ...documents[0], source_ids: ["undeclared"] }],
    [{ ...documents[0], extra: "ignored?" }],
    [...documents, documents[0]],
  ]) {
    invalid(
      () => validate_documents(provider, bad),
      "INVALID_PROVIDER_DOCUMENTS",
    );
  }
});

test("document validation rejects binary controls, lone surrogates and absent headings", () => {
  for (const text of [
    "",
    "   ",
    "\ud800",
    "# Purpose\n\0\n# Permissions",
    "# Purpose\n\u007f\n# Permissions",
    "No headings",
    "```md\n# Purpose\n# Permissions\n```",
    "~~~\n# Purpose\n# Permissions\n~~~",
  ]) {
    const documents = output();
    documents[0].text = text;
    invalid(
      () => validate_documents(fixture(), documents),
      "INVALID_PROVIDER_DOCUMENTS",
    );
  }
  const valid = output();
  valid[0].text =
    "# Purpose\r\nUnicode é🙂 and\ttabs.\r\n## Permissions ##\r\nRead only.";
  assert.equal(validate_documents(fixture(), valid)[0].text, valid[0].text);
});

test("UTF-8 document and aggregate limits include all declared output", () => {
  const provider = fixture();
  provider.documents[0].format = "text";
  provider.documents[0].validation.required_sections = [];
  provider.limits.document_bytes = 64;
  provider.limits.total_document_bytes = 100;
  const documents = output();
  documents[0].text = "é".repeat(32);
  assert.ok(validate_documents(provider, documents));
  documents[0].text += "a";
  invalid(
    () => validate_documents(provider, documents),
    "INVALID_PROVIDER_DOCUMENTS",
  );
  documents[0].text = "é".repeat(32);
  provider.documents.push({
    ...structuredClone(provider.documents[0]),
    id: "second",
  });
  documents.push({ ...structuredClone(documents[0]), id: "second" });
  invalid(
    () => validate_documents(provider, documents),
    "INVALID_PROVIDER_DOCUMENTS",
  );
});
