import { test } from "node:test";
import assert from "node:assert/strict";
import { applySplices, rewriteSpecifiers } from "../src/rewrite/splice.ts";
import * as ts from "typescript";

test("applySplices last-first so offsets stay valid", () => {
  const src = "abcDEF";
  const out = applySplices(src, [
    { start: 0, end: 3, text: "XYZ" },
    { start: 3, end: 6, text: "!" },
  ]);
  assert.equal(out, "XYZ!");
});

test("rewriteSpecifiers only touches the module string", () => {
  const src = `import _ from "lodash";\n// keep comment\nconst x = 1;\n`;
  const next = rewriteSpecifiers(ts, src, "a.ts", new Set(["lodash"]), "./slim/lodash.js");
  assert.equal(next.changed, true);
  assert.match(next.text, /from "\.\/slim\/lodash\.js"/);
  assert.match(next.text, /keep comment/);
  assert.equal(next.text.includes("const x = 1"), true);
});

test("rewriteSpecifiers rewrites CJS require string literals only", () => {
  const src = `const { get } = require("lodash");\nconst other = require(name);\n`;
  const next = rewriteSpecifiers(ts, src, "a.cjs", new Set(["lodash"]), "./slim/lodash.cjs");
  assert.equal(next.changed, true);
  assert.match(next.text, /require\("\.\/slim\/lodash\.cjs"\)/);
  assert.match(next.text, /require\(name\)/);
});

test("per-method default import becomes a named import of the slice", () => {
  const src = `import get from "lodash/get";\nimport getFn from "lodash.get";\n`;
  const next = rewriteSpecifiers(
    ts,
    src,
    "a.ts",
    new Set(["lodash/get", "lodash.get"]),
    "./slim/lodash.ts",
  );
  assert.equal(next.changed, true);
  assert.match(next.text, /import \{ get \} from "\.\/slim\/lodash\.ts"/);
  assert.match(next.text, /import \{ get as getFn \} from "\.\/slim\/lodash\.ts"/);
});

test("main-package default import stays default", () => {
  const src = `import _ from "lodash";\n`;
  const next = rewriteSpecifiers(ts, src, "a.ts", new Set(["lodash"]), "./slim/lodash.ts");
  assert.match(next.text, /import _ from "\.\/slim\/lodash\.ts"/);
});

test("per-method CJS default require reads the named export", () => {
  const src = `const get = require("lodash/get");\n`;
  const next = rewriteSpecifiers(ts, src, "a.cjs", new Set(["lodash/get"]), "./slim/lodash.cjs");
  assert.equal(next.text, `const get = require("./slim/lodash.cjs").get;\n`);
});
