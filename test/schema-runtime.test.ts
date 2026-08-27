import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { validateSchema, type JsonSchema } from "../src/schema/validate.ts";
import { assertDocument, loadSchema, validateNamed } from "../src/schema/documents.ts";
import { EXIT_FAIL, SlimExit } from "../src/exit.ts";
import { errorDocument } from "../src/json.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = join(ROOT, "docs");

const versioned: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "name"],
  properties: {
    schemaVersion: { type: "integer", const: 1 },
    name: { type: "string", minLength: 1 },
  },
};

test("validateSchema accepts a document that matches", () => {
  const issue = validateSchema(versioned, { schemaVersion: 1, name: "ok" });
  assert.equal(issue, null);
});

test("validateSchema missing required field is missing-field", () => {
  const issue = validateSchema(versioned, { schemaVersion: 1 });
  assert.equal(issue?.kind, "missing-field");
  assert.match(issue?.path ?? "", /name/);
});

test("validateSchema extra property is malformed", () => {
  const issue = validateSchema(versioned, { schemaVersion: 1, name: "ok", extra: true });
  assert.equal(issue?.kind, "malformed");
});

test("validateSchema wrong type is malformed", () => {
  const issue = validateSchema(versioned, { schemaVersion: 1, name: 12 });
  assert.equal(issue?.kind, "malformed");
});

test("validateSchema older schemaVersion is stale-version", () => {
  const issue = validateSchema(versioned, { schemaVersion: 0, name: "ok" });
  assert.equal(issue?.kind, "stale-version");
});

test("validateSchema future schemaVersion is incompatible-version", () => {
  const issue = validateSchema(versioned, { schemaVersion: 9, name: "ok" });
  assert.equal(issue?.kind, "incompatible-version");
});

test("validateSchema non-integer schemaVersion is incompatible-version", () => {
  const issue = validateSchema(versioned, { schemaVersion: "1", name: "ok" });
  assert.equal(issue?.kind, "incompatible-version");
});

test("validateSchema resolves local $defs refs", () => {
  const schema: JsonSchema = {
    type: "object",
    required: ["row"],
    properties: { row: { $ref: "#/$defs/row" } },
    $defs: {
      row: {
        type: "object",
        additionalProperties: false,
        required: ["id"],
        properties: { id: { type: "string" } },
      },
    },
  };
  assert.equal(validateSchema(schema, { row: { id: "a" } }), null);
  assert.equal(validateSchema(schema, { row: {} })?.kind, "missing-field");
});

test("validateSchema union types and null", () => {
  const schema: JsonSchema = {
    type: "object",
    required: ["lockfile"],
    properties: { lockfile: { type: ["string", "null"], enum: ["npm", "pnpm", "yarn", "bun", null] } },
  };
  assert.equal(validateSchema(schema, { lockfile: "npm" }), null);
  assert.equal(validateSchema(schema, { lockfile: null }), null);
  assert.equal(validateSchema(schema, { lockfile: "cargo" })?.kind, "malformed");
});

test("assertDocument throws SlimExit with classified kind for error schema", () => {
  const ok = errorDocument(2, "unknown command: nope");
  assertDocument("error", ok);
  assert.throws(
    () => assertDocument("error", { schemaVersion: 1, ok: false }),
    (err: unknown) =>
      err instanceof SlimExit && err.code === EXIT_FAIL && /missing-field/.test(err.message),
  );
  assert.throws(
    () => assertDocument("error", { ...ok, schemaVersion: 0 }),
    (err: unknown) =>
      err instanceof SlimExit && err.code === EXIT_FAIL && /stale-version/.test(err.message),
  );
  assert.throws(
    () => assertDocument("error", { ...ok, schemaVersion: 8 }),
    (err: unknown) =>
      err instanceof SlimExit && err.code === EXIT_FAIL && /incompatible-version/.test(err.message),
  );
});

test("loadSchema reads packed docs path for scan and envelope $ref", () => {
  const scan = loadSchema("scan");
  assert.equal((scan as { properties: { schemaVersion: { const: number } } }).properties.schemaVersion.const, 2);
  const inspect = loadSchema("inspect");
  const envRef = (inspect as { properties: { envelope: { $ref: string } } }).properties.envelope.$ref;
  assert.equal(envRef, "envelope.schema.json");
  assert.equal(typeof DOCS, "string");
});

test("named schemas classify missing, malformed, stale, and incompatible versions", () => {
  const names = [
    "slim",
    "manifest",
    "evidence",
    "envelope",
    "scan",
    "inspect",
    "check",
    "doctor",
    "upstream",
    "error",
    "inventory",
    "receipt",
  ] as const;
  for (const name of names) {
    const schema = loadSchema(name) as {
      required?: string[];
      properties?: { schemaVersion?: { const?: number } };
    };
    const expected = schema.properties?.schemaVersion?.const;
    if (typeof expected !== "number") continue;
    const required = schema.required ?? [];
    if (required.includes("schemaVersion")) {
      assert.equal(validateNamed(name, {})?.kind, "missing-field", name);
    }
    if (name === "slim") {
      assert.equal(validateNamed("slim", { schemaVersion: 0 })?.kind, "stale-version");
      assert.equal(validateNamed("slim", { schemaVersion: 9 })?.kind, "incompatible-version");
      assert.equal(validateNamed("slim", { extra: true })?.kind, "malformed");
      assert.equal(validateNamed("slim", {}), null);
    }
  }
  assert.equal(validateNamed("manifest", { schemaVersion: 1, replacements: {} }), null);
  assert.equal(validateNamed("manifest", { replacements: {} })?.kind, "missing-field");
  assert.equal(validateNamed("manifest", { schemaVersion: 0, replacements: {} })?.kind, "stale-version");
  assert.equal(validateNamed("manifest", { schemaVersion: 2, replacements: {} })?.kind, "incompatible-version");
  assert.equal(validateNamed("inventory", { schemaVersion: 1, entries: [] }), null);
  assert.equal(validateNamed("error", errorDocument(2, "nope")), null);
});

test("golden envelope and evidence validate", () => {
  const env = JSON.parse(
    readFileSync(join(DOCS, "../fixtures/lodash-get-debounce/.slim/lodash/envelope.json"), "utf8"),
  );
  assert.equal(validateNamed("envelope", env), null);
  const evidence = JSON.parse(
    readFileSync(join(DOCS, "../fixtures/lodash-get-debounce/.slim/lodash/evidence.json"), "utf8"),
  );
  assert.equal(validateNamed("evidence", evidence), null);
  const man = JSON.parse(
    readFileSync(join(DOCS, "../fixtures/lodash-get-debounce/.slim/manifest.json"), "utf8"),
  );
  assert.equal(validateNamed("manifest", man), null);
});

test("hash-only evidence fails schema; generation is required", () => {
  const hash = "a".repeat(64);
  assert.equal(
    validateNamed("evidence", { schemaVersion: 1, envelopeHash: hash })?.kind,
    "missing-field",
  );
  const full = JSON.parse(
    readFileSync(join(DOCS, "../fixtures/lodash-get-debounce/.slim/lodash/evidence.json"), "utf8"),
  ) as { generation?: unknown };
  assert.ok(full.generation);
  const { generation: _g, ...rest } = full;
  assert.equal(validateNamed("evidence", rest)?.kind, "missing-field");
});


