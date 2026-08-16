import { test } from "node:test";
import assert from "node:assert/strict";
import * as ts from "typescript";
import { validateGenerated } from "../src/generate/validate.ts";

test("allowlist accepts ordinary get", () => {
  const src = `export function get(o, p) { return o == null ? undefined : o[p]; }\n`;
  const r = validateGenerated(ts, src);
  assert.equal(r.ok, true, r.errors.join("; "));
});

test("allowlist rejects eval and Function", () => {
  assert.equal(validateGenerated(ts, `export const x = eval("1")`).ok, false);
  assert.equal(validateGenerated(ts, `export const F = new Function("return 1")`).ok, false);
});

test("allowlist rejects lodash import", () => {
  const r = validateGenerated(ts, `import get from "lodash/get";\nexport { get }\n`);
  assert.equal(r.ok, false);
});
