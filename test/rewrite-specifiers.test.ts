import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { rewriteSpecifiers } from "../src/rewrite/splice.ts";

const ts = createRequire(import.meta.url)("typescript") as typeof import("typescript");
const FROM = new Set(["lodash", "lodash/get"]);
const TO = "./src/slim/lodash.ts";

test("type-only import and export keep the original specifier", () => {
  const named = rewriteSpecifiers(
    ts,
    `import type { Dictionary } from "lodash";\nexport type T = Dictionary<string>;\n`,
    "src/a.ts",
    FROM,
    TO,
  );
  assert.equal(named.changed, false);
  assert.match(named.text, /from "lodash"/);

  const exported = rewriteSpecifiers(
    ts,
    `export type { Dictionary } from "lodash";\n`,
    "src/b.ts",
    FROM,
    TO,
  );
  assert.equal(exported.changed, false);
  assert.match(exported.text, /from "lodash"/);
});

test("import type default from lodash/get is not rewritten into a runtime named import", () => {
  const out = rewriteSpecifiers(
    ts,
    `import type get from "lodash/get";\nexport type G = typeof get;\n`,
    "src/c.ts",
    FROM,
    TO,
  );
  assert.equal(out.changed, false);
  assert.match(out.text, /from "lodash\/get"/);
  assert.doesNotMatch(out.text, /\{\s*get\s*\}/);
});

test("mixed type and runtime named import still rewrites the specifier", () => {
  const out = rewriteSpecifiers(
    ts,
    `import { type Dictionary, get } from "lodash";\nexport const v = get({}, "a");\n`,
    "src/d.ts",
    FROM,
    TO,
  );
  assert.equal(out.changed, true);
  assert.match(out.text, /from "\.\/src\/slim\/lodash\.ts"/);
  assert.match(out.text, /type Dictionary/);
});
