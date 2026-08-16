import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { loadProject } from "../src/project.ts";
import { analyzePackage } from "../src/analyze/index.ts";
import { refusePackage } from "../src/scan/refuse.ts";

const root = join(import.meta.dirname, "../fixtures/lodash-get-debounce");

test("golden fixture envelope is get+debounce", () => {
  const env = analyzePackage(loadProject(root), "lodash");
  const names = env.symbols.map((s) => s.exportName).sort();
  assert.ok(names.includes("get"));
  assert.ok(names.includes("debounce"));
  assert.equal(env.unknowns.filter((u) => u.widensTo === "refuse").length, 0);
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
});
