import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProject } from "../src/project.ts";
import { analyzePackage } from "../src/analyze/index.ts";
import { formatRefuse, refusePackage } from "../src/scan/refuse.ts";

const root = join(import.meta.dirname, "../fixtures/lodash-get-debounce");

test("golden fixture envelope is get+debounce", () => {
  const env = JSON.parse(readFileSync(join(root, ".slim/lodash/envelope.json"), "utf8")) as {
    symbols: Array<{ exportName: string }>;
    unknowns: Array<{ widensTo?: string }>;
  };
  const names = env.symbols.map((s) => s.exportName).sort();
  assert.ok(names.includes("get"));
  assert.ok(names.includes("debounce"));
  assert.equal(env.unknowns.filter((u) => u.widensTo === "refuse").length, 0);
});

test("golden fixture used-graph is pure despite Date.now in debounce", () => {
  const env = JSON.parse(readFileSync(join(root, ".slim/lodash/envelope.json"), "utf8")) as {
    slimmable: { score: number; verdict: string };
  };
  assert.ok(env.slimmable.score >= 40);
  assert.notEqual(env.slimmable.verdict, "refuse");
});

test("golden fixture ships tree-shaken slim lodash without the package", () => {
  const src = readFileSync(join(root, "src/slim/lodash.ts"), "utf8");
  assert.match(src, /SPDX-License-Identifier: MIT/);
  assert.match(src, /export function get/);
  assert.match(src, /export function debounce/);
  assert.doesNotMatch(src, /from ["']lodash/);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  assert.equal(pkg.dependencies?.lodash, undefined);
});

test("golden fixture envelope has relative locs, no traces, no bind.placeholder", () => {
  const raw = readFileSync(join(root, ".slim/lodash/envelope.json"), "utf8");
  assert.equal(raw.includes("bind.placeholder"), false);
  const env = JSON.parse(raw) as {
    traces?: unknown[];
    env: string[];
    imports: Array<{ loc: { file: string } }>;
    symbols: Array<{
      callSites: Array<{ loc: { file: string } }>;
      coverage: { callSitesTraced: number };
    }>;
  };
  assert.ok(!env.traces || env.traces.length === 0);
  assert.ok(env.env.includes("worker"), `env=${env.env.join(",")}`);
  assert.ok(env.env.includes("node"));
  assert.ok(
    env.symbols.some((s) => s.coverage.callSitesTraced > 0),
    "expected coverage.callSitesTraced > 0",
  );
  const files = [
    ...env.imports.map((i) => i.loc.file),
    ...env.symbols.flatMap((s) => s.callSites.map((c) => c.loc.file)),
  ];
  assert.ok(files.length > 0);
  for (const file of files) {
    assert.equal(file.startsWith("/"), false, file);
    assert.doesNotMatch(file, /\\/);
  }
  const src = readFileSync(join(root, "src/slim/lodash.ts"), "utf8");
  assert.ok(src.split("\n").length < 280, `lodash.ts is ${src.split("\n").length} lines`);
});

test("golden fixture evidence replays traces and has sections 2-8", () => {
  const json = JSON.parse(readFileSync(join(root, ".slim/lodash/evidence.json"), "utf8")) as {
    package: { version: string };
    fuzz: { tracesReplayed: number };
    residualRisk: string[];
  };
  const md = readFileSync(join(root, ".slim/lodash/evidence.md"), "utf8");
  assert.ok(json.fuzz.tracesReplayed > 0, `tracesReplayed=${json.fuzz.tracesReplayed}`);
  assert.ok(json.residualRisk.length > 0);
  assert.equal(json.package.version, "4.17.21");
  assert.match(md, /^## 2\. What was used/m);
  assert.match(md, /^## 3\. Byte delta/m);
  assert.match(md, /^## 4\. Edge/m);
  assert.match(md, /^## 5\. Fuzz/m);
  assert.match(md, /^## 6\. Coverage holes/m);
  assert.match(md, /^## 7\. Upstream pin/m);
  assert.match(md, /^## 8\. How to revert/m);
  assert.match(md, /traces replayed: [1-9]/);
});

test("golden fixture is Worker-shaped", () => {
  const wrangler = readFileSync(join(root, "wrangler.toml"), "utf8");
  assert.match(wrangler, /main\s*=\s*"src\/worker\.ts"/);
  const worker = readFileSync(join(root, "src/worker.ts"), "utf8");
  assert.match(worker, /async fetch\(/);
  assert.match(worker, /pickUser/);
  assert.match(worker, /schedule/);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    devDependencies?: Record<string, string>;
  };
  assert.ok(pkg.devDependencies?.["@cloudflare/workers-types"]);
});

test("dynamic fixture is not closed", () => {
  const r = join(import.meta.dirname, "../fixtures/lodash-dynamic-refuse");
  const env = analyzePackage(loadProject(r), "lodash");
  assert.ok(env.unknowns.some((u) => u.kind === "dynamic-member"));
  assert.equal(env.closure.readyToGenerate, false);
});

test("better-sqlite3 is refused", () => {
  const r = refusePackage("better-sqlite3");
  assert.ok(r);
  assert.match(r!.why, /native/i);
  assert.ok(r!.evidence);
  assert.ok(r!.whatToDo);
  assert.match(formatRefuse(r!), /why:/);
});

test("axios and react are refused", () => {
  const axios = refusePackage("axios");
  const react = refusePackage("react");
  assert.ok(axios);
  assert.ok(react);
  assert.match(axios!.why, /network|HTTP/i);
  assert.match(react!.why, /framework/i);
  assert.match(formatRefuse(axios!), /evidence:/);
  assert.match(formatRefuse(react!), /what:/);
});

test("node-gyp is refused", () => {
  const r = refusePackage("node-gyp");
  assert.ok(r);
  assert.match(r!.why, /native|gyp|addon/i);
  assert.ok(r!.evidence);
  assert.ok(r!.whatToDo);
});

test("installed package directory with a .node file is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-node-"));
  writeFileSync(join(dir, "addon.node"), "");
  const r = refusePackage("fake-native", dir);
  assert.ok(r);
  assert.match(r!.why, /native|\.node/i);
  assert.match(r!.evidence, /\.node/);
  assert.ok(r!.whatToDo);
  assert.match(formatRefuse(r!), /refused fake-native/);
});
