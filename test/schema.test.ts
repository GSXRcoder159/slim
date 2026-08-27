import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_FIELDS = ["outDir", "budgetMs", "testCommand", "include", "ignore", "replacements"] as const;

function walkDocs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walkDocs(p));
    else if (/\.(md|json|txt|yml|yaml|js)$/.test(name)) out.push(p);
  }
  return out;
}

test("docs/slim.schema.json matches config.ts fields", () => {
  const schema = JSON.parse(readFileSync(join(ROOT, "docs/slim.schema.json"), "utf8")) as {
    description?: string;
    properties: Record<string, { default?: unknown }>;
  };
  const keys = Object.keys(schema.properties).filter((k) => k !== "$schema").sort();
  assert.deepEqual(keys, [...CONFIG_FIELDS, "schemaVersion"].sort());
  assert.equal(schema.properties.outDir?.default, "src/slim");
  assert.equal("dir" in schema.properties, false);
  assert.equal("fuzzIterations" in schema.properties, false);
  assert.doesNotMatch(JSON.stringify(schema), /vendor\/slim/);
});

test("docs/examples/slim.json matches config.ts fields", () => {
  const ex = JSON.parse(readFileSync(join(ROOT, "docs/examples/slim.json"), "utf8")) as Record<
    string,
    unknown
  >;
  for (const field of CONFIG_FIELDS) {
    assert.ok(field in ex, `missing ${field}`);
  }
  assert.equal(ex.outDir, "src/slim");
  assert.equal("dir" in ex, false);
  assert.equal("fuzzIterations" in ex, false);
  assert.doesNotMatch(JSON.stringify(ex), /vendor\/slim/);
});

test("docs replace vendor/slim with src/slim", () => {
  const hits: string[] = [];
  for (const file of walkDocs(join(ROOT, "docs"))) {
    const text = readFileSync(file, "utf8");
    if (text.includes("vendor/slim")) hits.push(file.slice(ROOT.length + 1));
  }
  assert.deepEqual(hits, [], `leftover vendor/slim in ${hits.join(", ")}`);
});

test("docs slices are TypeScript, not 67-line lodash.js", () => {
  const jsHits: string[] = [];
  const lineHits: string[] = [];
  for (const file of walkDocs(join(ROOT, "docs"))) {
    if (!/\.(md|json|txt|yml|yaml)$/.test(file)) continue;
    const rel = file.slice(ROOT.length + 1);
    const text = readFileSync(file, "utf8");
    if (text.includes("src/slim/lodash.js")) jsHits.push(rel);
    if (/\b67 lines\b/.test(text) || /generate\s+\S+\s+\(67 lines\)/.test(text)) lineHits.push(rel);
  }
  assert.deepEqual(jsHits, [], `src/slim/lodash.js in ${jsHits.join(", ")}`);
  assert.deepEqual(lineHits, [], `67-line generate claim in ${lineHits.join(", ")}`);
});

test("docs/scan.schema.json matches ScanReport required fields", () => {
  const schema = JSON.parse(readFileSync(join(ROOT, "docs/scan.schema.json"), "utf8")) as {
    required: string[];
    $defs: { row: { required: string[] } };
  };
  assert.deepEqual(schema.required.sort(), ["lockfile", "rows", "schemaVersion"]);
  const rowKeys = [
    "declaredAs",
    "family",
    "gzipBytes",
    "importSites",
    "minBytes",
    "name",
    "note",
    "relation",
    "sizeProvenance",
    "sizeState",
    "slimmable",
    "subpaths",
    "typeOnlySites",
    "verdict",
    "version",
    "versionReason",
    "versionState",
  ];
  assert.deepEqual(schema.$defs.row.required.slice().sort(), rowKeys);
});

test("docs/envelope.schema.json requires envelope + closure ID lists", () => {
  const schema = JSON.parse(readFileSync(join(ROOT, "docs/envelope.schema.json"), "utf8")) as {
    required: string[];
    $defs: {
      closure: { required: string[] };
      hyrumFlags: { required: string[] };
      slimValue: { properties: { proto?: unknown; toStr?: unknown; syms?: unknown } };
    };
  };
  assert.deepEqual(
    schema.required.sort(),
    [
      "clock",
      "closure",
      "cryptoRandom",
      "env",
      "imports",
      "package",
      "schemaVersion",
      "slimmable",
      "symbols",
      "traces",
      "unknowns",
    ].sort(),
  );
  assert.deepEqual(
    schema.$defs.closure.required.slice().sort(),
    [
      "confidence",
      "readyToGenerate",
      "reason",
      "staticCallSiteIds",
      "tracedCallSiteIds",
      "untracedCallSiteIds",
    ].sort(),
  );
  assert.deepEqual(
    schema.$defs.hyrumFlags.required.slice().sort(),
    [
      "dateIdentity",
      "errorMessage",
      "json",
      "keyOrder",
      "mutation",
      "nan",
      "prototype",
      "sameReference",
      "signedZero",
      "sparseArray",
      "toString",
    ],
  );
  assert.ok(schema.$defs.slimValue.properties.proto);
  assert.ok(schema.$defs.slimValue.properties.toStr);
  assert.ok(schema.$defs.slimValue.properties.syms);
});

test("command result schemas exist with required fields", () => {
  const check = JSON.parse(readFileSync(join(ROOT, "docs/check.schema.json"), "utf8")) as {
    required: string[];
  };
  assert.deepEqual(check.required.sort(), ["exit", "ok", "packages", "schemaVersion", "status"].sort());
  const err = JSON.parse(readFileSync(join(ROOT, "docs/error.schema.json"), "utf8")) as {
    required: string[];
  };
  assert.deepEqual(err.required.sort(), ["error", "exit", "ok", "schemaVersion", "status"].sort());
  const inspect = JSON.parse(readFileSync(join(ROOT, "docs/inspect.schema.json"), "utf8")) as {
    required: string[];
  };
  assert.deepEqual(inspect.required.sort(), ["decision", "envelope", "hash", "reason", "schemaVersion"].sort());
  const doctor = JSON.parse(readFileSync(join(ROOT, "docs/doctor.schema.json"), "utf8")) as {
    required: string[];
  };
  for (const key of ["ok", "exit", "status", "node", "issues"]) {
    assert.ok(doctor.required.includes(key), key);
  }
  const upstream = JSON.parse(readFileSync(join(ROOT, "docs/upstream.schema.json"), "utf8")) as {
    required: string[];
  };
  assert.deepEqual(upstream.required.sort(), ["conclusion", "exit", "findings", "ok", "schemaVersion", "sources", "status"].sort());
});

test("evidence, manifest, inventory, and receipt schemas are versioned", () => {
  const evidence = JSON.parse(readFileSync(join(ROOT, "docs/evidence.schema.json"), "utf8")) as {
    required: string[];
    properties: { schemaVersion: { const: number } };
  };
  assert.equal(evidence.properties.schemaVersion.const, 1);
  assert.ok(evidence.required.includes("schemaVersion"));
  assert.ok(evidence.required.includes("generation"));
  const man = JSON.parse(readFileSync(join(ROOT, "docs/manifest.schema.json"), "utf8")) as {
    required: string[];
  };
  assert.deepEqual(man.required.sort(), ["replacements", "schemaVersion"].sort());
  const inv = JSON.parse(readFileSync(join(ROOT, "docs/support-inventory.schema.json"), "utf8")) as {
    required: string[];
  };
  assert.deepEqual(inv.required.sort(), ["entries", "schemaVersion"].sort());
  const rec = JSON.parse(readFileSync(join(ROOT, "docs/receipt.schema.json"), "utf8")) as {
    required: string[];
    additionalProperties: boolean;
  };
  assert.equal(rec.additionalProperties, false);
  for (const key of ["schemaVersion", "checkId", "commit", "outcome", "logDigest"]) {
    assert.ok(rec.required.includes(key), key);
  }
});

test("friday walkthrough documents --no-install", () => {
  const md = readFileSync(join(ROOT, "docs/friday.md"), "utf8");
  assert.match(md, /--no-install/);
});
