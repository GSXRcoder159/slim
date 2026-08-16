import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProject } from "../src/project.ts";
import { analyzePackage } from "../src/analyze/index.ts";
import { formatRefuse, refusePackage } from "../src/scan/refuse.ts";

const root = join(import.meta.dirname, "../fixtures/lodash-get-debounce");

test("golden fixture envelope is get+debounce", () => {
  const env = analyzePackage(loadProject(root), "lodash");
  const names = env.symbols.map((s) => s.exportName).sort();
  assert.ok(names.includes("get"));
  assert.ok(names.includes("debounce"));
  assert.equal(env.unknowns.filter((u) => u.widensTo === "refuse").length, 0);
});

test("golden fixture used-graph is pure despite Date.now in debounce", () => {
  const env = analyzePackage(loadProject(root), "lodash");
  assert.ok(env.slimmable.score >= 40);
  assert.notEqual(env.slimmable.verdict, "refuse");
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
