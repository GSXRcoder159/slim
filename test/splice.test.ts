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
