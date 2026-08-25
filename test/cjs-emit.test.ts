import { test } from "node:test";
import assert from "node:assert/strict";
import * as ts from "typescript";
import { emitCjsSource, isCjsConsumer } from "../src/rewrite/cjs-emit.ts";

test("isCjsConsumer treats .cjs and CJS .js as consumers", () => {
  assert.equal(isCjsConsumer("src/a.cjs", "module"), true);
  assert.equal(isCjsConsumer("src/a.js", undefined), true);
  assert.equal(isCjsConsumer("src/a.js", "module"), false);
  assert.equal(isCjsConsumer("src/a.ts", undefined), false);
});

test("emitCjsSource makes a default function callable via require()", () => {
  const src = `export function ms(x) { return x; }\nexport default ms;\n`;
  const out = emitCjsSource(ts, src, "ms.ts");
  assert.match(out, /exports\.default/);
  assert.match(out, /typeof _slimDefault === "function"/);
});
