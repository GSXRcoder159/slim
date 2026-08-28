import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { generatedHeader } from "../src/generate/header.ts";
import { ENVELOPE_VERSION, emptyHyrum } from "../src/envelope/types.ts";
import type { Envelope } from "../src/envelope/types.ts";
import { MIN_NODE_ENGINES, MIN_NODE_LABEL } from "../src/node-min.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const DOC_EXTS = new Set([".md", ".txt", ".yml", ".yaml"]);

function walkDocs(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "dist" || e === ".git" || e === "transcripts") continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walkDocs(p, acc);
    else if (DOC_EXTS.has(e.slice(e.lastIndexOf(".")))) acc.push(p);
  }
  return acc;
}

function env(): Envelope {
  return {
    schemaVersion: ENVELOPE_VERSION,
    package: { name: "lodash", version: "4.17.21", family: "lodash", subpath: "" },
    env: ["node"],
    imports: [],
    symbols: [
      {
        exportName: "get",
        packages: [],
        callSites: [],
        resultMembers: [],
        hyrum: emptyHyrum(),
        coverage: { callSitesStatic: 1, callSitesTraced: 0 },
      },
    ],
    unknowns: [],
    traces: [],
    closure: {
      confidence: "closed",
      readyToGenerate: true,
      staticCallSiteIds: [],
      tracedCallSiteIds: [],
      untracedCallSiteIds: [],
      reason: "test",
    },
    slimmable: { score: 80, verdict: "slim", blockers: [], reasons: [] },
    clock: false,
    cryptoRandom: false,
  };
}

test("README, doctor, and engines agree on Node 22.18", () => {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const doctor = readFileSync(join(ROOT, "src/doctor.ts"), "utf8");
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    engines: { node: string };
  };
  assert.match(readme, /22\.18/);
  assert.doesNotMatch(readme, /20\.12/);
  assert.match(doctor, /MIN_NODE_LABEL/);
  assert.doesNotMatch(doctor, /22\.15/);
  assert.equal(pkg.engines.node, MIN_NODE_ENGINES);
});

test("public docs do not advertise slim-js or Apache-2.0", () => {
  const files = [
    join(ROOT, "README.md"),
    join(ROOT, "CONTRIBUTING.md"),
    join(ROOT, "SECURITY.md"),
    join(ROOT, "CODE_OF_CONDUCT.md"),
    ...walkDocs(join(ROOT, "docs")),
    ...walkDocs(join(ROOT, ".github")),
  ];
  const hits: string[] = [];
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    if (text.includes("slim-js/slim") || text.includes("Apache-2.0")) {
      hits.push(`${relative(ROOT, f)}: slim-js or Apache-2.0`);
    }
  }
  assert.deepEqual(hits, []);
});

test("package.json files includes command JSON schemas and CHANGELOG", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    files: string[];
  };
  assert.ok(pkg.files.includes("docs/*.schema.json"), "files must ship docs/*.schema.json");
  assert.ok(pkg.files.includes("docs/support-inventory.json"), "files must ship support inventory");
  assert.ok(pkg.files.includes("CHANGELOG.md"), "files must ship CHANGELOG.md");
  assert.ok(existsSync(join(ROOT, "CHANGELOG.md")));
});

test("generated header is SPDX MIT without a categorical not-derived claim", () => {
  const h = generatedHeader(env());
  assert.match(h, /SPDX-License-Identifier: MIT/);
  assert.match(h, /not affiliated/i);
  assert.match(h, /evidence, not proof/i);
  assert.doesNotMatch(h, /not derived/i);
});

test("catalog sources do not claim not-derived", () => {
  const hits: string[] = [];
  function walk(dir: string): void {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e.endsWith(".ts")) {
        const text = readFileSync(p, "utf8");
        if (/not derived/i.test(text)) hits.push(relative(ROOT, p));
      }
    }
  }
  walk(join(ROOT, "src/generate/catalog"));
  assert.deepEqual(hits, []);
});

test("Friday transcript is marked historical", () => {
  const t = readFileSync(join(ROOT, "docs/transcripts/friday-lodash.txt"), "utf8");
  assert.match(t, /HISTORICAL/i);
});

test("CI matrix is OS × Node 22.18 and 24", () => {
  const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  assert.match(ci, /ubuntu-latest/);
  assert.match(ci, /macos-latest/);
  assert.match(ci, /windows-latest/);
  assert.match(ci, /"22\.18"/);
  assert.match(ci, /"24"/);
  assert.match(ci, /fail-fast:\s*false/);
});

test("release qualifies before provenance publish", () => {
  const rel = readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8");
  assert.match(rel, /npm test/);
  assert.match(rel, /similarity-gate/);
  assert.match(rel, /pack-destination/);
  assert.match(rel, /npm publish --dry-run/);
  assert.match(rel, /sha256/);
  const publish = rel.lastIndexOf("npm publish --provenance");
  const dry = rel.indexOf("npm publish --dry-run");
  const test = rel.indexOf("npm test");
  assert.ok(test >= 0 && dry >= 0 && publish >= 0);
  assert.ok(test < dry && dry < publish, "test and dry-run must precede provenance publish");
});

test("consumer Action examples include checkout, setup-node, and npm ci", () => {
  for (const name of ["slim-check.yml", "slim-bloat.yml", "slim-watch.yml"] as const) {
    const yml = readFileSync(join(ROOT, "docs/examples", name), "utf8");
    assert.match(yml, /actions\/checkout@/);
    assert.match(yml, /actions\/setup-node@/);
    assert.match(yml, /node-version:\s*"22\.18"/);
    assert.match(yml, /npm ci/);
    assert.doesNotMatch(yml, /experimental-strip-types/);
    assert.doesNotMatch(yml, /SLIM_REQUIRE_DIST/);
    assert.doesNotMatch(yml, /fail:\s*true/);
  }
  const check = readFileSync(join(ROOT, "docs/examples/slim-check.yml"), "utf8");
  assert.match(check, /slim-hq\/slim\/action\/check@v1/);
  const bloat = readFileSync(join(ROOT, "docs/examples/slim-bloat.yml"), "utf8");
  assert.match(bloat, /slim-hq\/slim\/action\/bloat@v1/);
  const watch = readFileSync(join(ROOT, "docs/examples/slim-watch.yml"), "utf8");
  assert.match(watch, /slim-hq\/slim\/action\/upstream@v1/);
  const dx = readFileSync(join(ROOT, "docs/dx.md"), "utf8");
  assert.doesNotMatch(dx, /still falls back to source/);
  assert.doesNotMatch(dx, /Default: comment, exit 0/);
  const repo = readFileSync(join(ROOT, "docs/repo.md"), "utf8");
  assert.doesNotMatch(repo, /may fall back to source/);
});
