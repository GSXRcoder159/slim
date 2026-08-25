import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { OriginalSourceGuard } from "../src/generate/guard.ts";
import { loadPublicApi } from "../src/generate/public-api.ts";

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), "slim-papi-"));
}

function write(root: string, rel: string, body: string): string {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
  return abs;
}

test("scoped bundled types from exports['.'].types", () => {
  const root = tmpProject();
  write(
    root,
    "node_modules/@scope/pkg/package.json",
    JSON.stringify({ name: "@scope/pkg", exports: { ".": { types: "./dist/index.d.ts" } } }),
  );
  write(root, "node_modules/@scope/pkg/dist/index.d.ts", "export function scoped(): void;\n");
  const spec = loadPublicApi(root, "@scope/pkg");
  assert.equal(spec.source, "bundled-dts");
  assert.match(spec.text, /export function scoped/);
  assert.ok(spec.from?.endsWith("dist/index.d.ts"));
});

test("unscoped DefinitelyTyped @types/ms when package has no dts", () => {
  const root = tmpProject();
  write(root, "node_modules/ms/package.json", JSON.stringify({ name: "ms", main: "index.js" }));
  write(root, "node_modules/ms/index.js", "module.exports = function ms() {};\n");
  write(root, "node_modules/@types/ms/index.d.ts", "export function ms(val: string): number;\n");
  const spec = loadPublicApi(root, "ms");
  assert.equal(spec.source, "types-package");
  assert.match(spec.text, /export function ms/);
});

test("scoped DefinitelyTyped uses @types/scope__pkg not @types/@scope/pkg", () => {
  const root = tmpProject();
  write(root, "node_modules/@scope/pkg/package.json", JSON.stringify({ name: "@scope/pkg" }));
  write(root, "node_modules/@scope/pkg/index.js", "export const FROM_WRONG = 1;\n");
  write(
    root,
    "node_modules/@types/@scope/pkg/index.d.ts",
    "export function wrongPath(): void;\n",
  );
  write(
    root,
    "node_modules/@types/scope__pkg/index.d.ts",
    "export function scopedTypes(): void;\n",
  );
  const spec = loadPublicApi(root, "@scope/pkg");
  assert.equal(spec.source, "types-package");
  assert.match(spec.text, /scopedTypes/);
  assert.doesNotMatch(spec.text, /wrongPath/);
});

test("bundled types field dist/index.d.ts", () => {
  const root = tmpProject();
  write(
    root,
    "node_modules/kit/package.json",
    JSON.stringify({ name: "kit", types: "dist/index.d.ts" }),
  );
  write(root, "node_modules/kit/dist/index.d.ts", "export const kit: string;\n");
  const spec = loadPublicApi(root, "kit");
  assert.equal(spec.source, "bundled-dts");
  assert.match(spec.text, /export const kit/);
});

test("subpath types from exports not root types", () => {
  const root = tmpProject();
  write(
    root,
    "node_modules/lodash/package.json",
    JSON.stringify({
      name: "lodash",
      types: "index.d.ts",
      exports: {
        ".": { types: "./index.d.ts" },
        "./get": { types: "./get.d.ts" },
      },
    }),
  );
  write(root, "node_modules/lodash/index.d.ts", "export function map(): void;\n");
  write(root, "node_modules/lodash/get.d.ts", "export function get(): unknown;\n");
  const spec = loadPublicApi(root, "lodash", "get");
  assert.equal(spec.source, "subpath-dts");
  assert.match(spec.text, /export function get/);
  assert.doesNotMatch(spec.text, /export function map/);
});

test("README-only fallback", () => {
  const root = tmpProject();
  write(root, "node_modules/leftpad/package.json", JSON.stringify({ name: "leftpad" }));
  write(root, "node_modules/leftpad/README.md", "# leftpad\n\nPads a string on the left.\n");
  const spec = loadPublicApi(root, "leftpad");
  assert.equal(spec.source, "readme");
  assert.match(spec.text, /Pads a string/);
});

test("envelope-only when no dts or README", () => {
  const root = tmpProject();
  write(root, "node_modules/mystery/package.json", JSON.stringify({ name: "mystery" }));
  const spec = loadPublicApi(root, "mystery");
  assert.equal(spec.source, "envelope-only");
  assert.ok(spec.limitation);
  assert.match(spec.limitation!, /no local \.d\.ts or README/);
  assert.match(spec.text, /envelope call sites only/);
});

test("never includes implementation .js in public spec", () => {
  const root = tmpProject();
  write(
    root,
    "node_modules/trap/package.json",
    JSON.stringify({ name: "trap", types: "index.d.ts" }),
  );
  write(root, "node_modules/trap/index.js", "export const FROM_IMPL = 1;\n");
  write(root, "node_modules/trap/index.d.ts", "export function trap(): void;\n");
  const spec = loadPublicApi(root, "trap");
  assert.doesNotMatch(spec.text, /FROM_IMPL/);
  assert.match(spec.text, /export function trap/);
  assert.throws(
    () => OriginalSourceGuard.readPublicSpec(join(root, "node_modules/trap/index.js")),
    /OriginalSourceGuard/,
  );
});
