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

test("friday walkthrough documents --no-install", () => {
  const md = readFileSync(join(ROOT, "docs/friday.md"), "utf8");
  assert.match(md, /--no-install/);
});
