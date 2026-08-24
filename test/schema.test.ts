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
  assert.deepEqual(keys, [...CONFIG_FIELDS].sort());
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
    "verdict",
    "version",
    "versionReason",
    "versionState",
  ];
  assert.deepEqual(schema.$defs.row.required.slice().sort(), rowKeys);
});

test("friday walkthrough documents --no-install", () => {
  const md = readFileSync(join(ROOT, "docs/friday.md"), "utf8");
  assert.match(md, /--no-install/);
});
