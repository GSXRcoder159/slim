import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EXIT_FAIL, SlimExit } from "../src/exit.ts";
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

const SENTINEL = "SENTINEL_PUBLIC_SPEC_ESCAPE";

function assertEscapingSpec(root: string, pkg: string, subpath = ""): void {
  assert.throws(
    () => loadPublicApi(root, pkg, subpath),
    (err: unknown) => {
      assert.ok(err instanceof SlimExit, String(err));
      assert.equal(err.code, EXIT_FAIL);
      assert.match(err.message, /public spec|escapes/i);
      assert.doesNotMatch(err.message, new RegExp(SENTINEL));
      return true;
    },
  );
}

test("types traversal cannot escape the package root", () => {
  const root = tmpProject();
  const outside = write(root, "SENTINEL.d.ts", `export const ${SENTINEL} = 1;\n`);
  write(
    root,
    "node_modules/evil/package.json",
    JSON.stringify({ name: "evil", types: "../../SENTINEL.d.ts" }),
  );
  write(root, "node_modules/evil/index.js", "module.exports = 1;\n");
  assertEscapingSpec(root, "evil");
  assert.ok(outside.endsWith("SENTINEL.d.ts"));
});

test("typings traversal cannot escape the package root", () => {
  const root = tmpProject();
  write(root, "SECRET.d.ts", `export const ${SENTINEL} = 1;\n`);
  write(
    root,
    "node_modules/evil/package.json",
    JSON.stringify({ name: "evil", typings: "../../SECRET.d.ts" }),
  );
  assertEscapingSpec(root, "evil");
});

test("exports['.'].types traversal cannot escape the package root", () => {
  const root = tmpProject();
  write(root, "OUT.d.ts", `export const ${SENTINEL} = 1;\n`);
  write(
    root,
    "node_modules/evil/package.json",
    JSON.stringify({ name: "evil", exports: { ".": { types: "../../OUT.d.ts" } } }),
  );
  assertEscapingSpec(root, "evil");
});

test("subpath exports types traversal cannot escape the package root", () => {
  const root = tmpProject();
  write(root, "SUB.d.ts", `export const ${SENTINEL} = 1;\n`);
  write(
    root,
    "node_modules/evil/package.json",
    JSON.stringify({
      name: "evil",
      exports: { "./x": { types: "../../SUB.d.ts" } },
    }),
  );
  assertEscapingSpec(root, "evil", "x");
});

test("absolute types path cannot escape the package root", () => {
  const root = tmpProject();
  const abs = write(mkdtempSync(join(tmpdir(), "slim-papi-abs-")), "ABS.d.ts", `export const ${SENTINEL} = 1;\n`);
  write(
    root,
    "node_modules/evil/package.json",
    JSON.stringify({ name: "evil", types: abs }),
  );
  assertEscapingSpec(root, "evil");
});

test("symlink .d.ts whose realpath leaves the package is refused", () => {
  const root = tmpProject();
  const outside = write(root, "link-target.d.ts", `export const ${SENTINEL} = 1;\n`);
  write(root, "node_modules/evil/package.json", JSON.stringify({ name: "evil", types: "index.d.ts" }));
  symlinkSync(outside, join(root, "node_modules/evil/index.d.ts"));
  assertEscapingSpec(root, "evil");
});

test("symlink README whose realpath leaves the package is refused", () => {
  const root = tmpProject();
  const outside = write(root, "OUTSIDE.md", `# ${SENTINEL}\n`);
  write(root, "node_modules/evil/package.json", JSON.stringify({ name: "evil" }));
  symlinkSync(outside, join(root, "node_modules/evil/README.md"));
  assertEscapingSpec(root, "evil");
});

test("sibling package types cannot be read as this package's spec", () => {
  const root = tmpProject();
  write(root, "node_modules/other/secret.d.ts", `export const ${SENTINEL} = 1;\n`);
  write(
    root,
    "node_modules/evil/package.json",
    JSON.stringify({ name: "evil", types: "../other/secret.d.ts" }),
  );
  assertEscapingSpec(root, "evil");
});

test("package name traversal cannot leave node_modules", () => {
  const root = tmpProject();
  write(root, "SENTINEL.d.ts", `export const ${SENTINEL} = 1;\n`);
  assert.throws(
    () => loadPublicApi(root, "../SENTINEL.d.ts"),
    SlimExit,
  );
});

test("package directory symlinked outside node_modules is refused before reading specs", () => {
  const root = tmpProject();
  const outside = mkdtempSync(join(tmpdir(), "slim-papi-pkg-"));
  write(outside, "package.json", JSON.stringify({ name: "evil", types: "index.d.ts" }));
  write(outside, "index.d.ts", `export const ${SENTINEL} = 1;\n`);
  mkdirSync(join(root, "node_modules"), { recursive: true });
  symlinkSync(outside, join(root, "node_modules/evil"));
  assertEscapingSpec(root, "evil");
});

test("package.json whose realpath leaves the package root is refused", () => {
  const root = tmpProject();
  const outside = write(
    mkdtempSync(join(tmpdir(), "slim-papi-meta-")),
    "package.json",
    JSON.stringify({ name: "evil", types: "index.d.ts" }),
  );
  write(root, "node_modules/evil/index.d.ts", `export const ${SENTINEL} = 1;\n`);
  symlinkSync(outside, join(root, "node_modules/evil/package.json"));
  assertEscapingSpec(root, "evil");
});

test("pnpm-style package dir symlink that stays inside node_modules is accepted", () => {
  const root = tmpProject();
  write(
    root,
    "node_modules/.pnpm/kit@1.0.0/node_modules/kit/package.json",
    JSON.stringify({ name: "kit", types: "index.d.ts" }),
  );
  write(
    root,
    "node_modules/.pnpm/kit@1.0.0/node_modules/kit/index.d.ts",
    "export function kit(): void;\n",
  );
  mkdirSync(join(root, "node_modules"), { recursive: true });
  symlinkSync(
    join(root, "node_modules/.pnpm/kit@1.0.0/node_modules/kit"),
    join(root, "node_modules/kit"),
  );
  const spec = loadPublicApi(root, "kit");
  assert.equal(spec.source, "bundled-dts");
  assert.match(spec.text, /export function kit/);
  assert.doesNotMatch(spec.text, new RegExp(SENTINEL));
});

test("file: vendor package dir symlink inside the project is accepted", () => {
  const root = tmpProject();
  write(
    root,
    "vendor/tiny-add/package.json",
    JSON.stringify({ name: "tiny-add", types: "index.d.ts" }),
  );
  write(root, "vendor/tiny-add/index.d.ts", "export function add(a: number, b: number): number;\n");
  mkdirSync(join(root, "node_modules"), { recursive: true });
  symlinkSync(join(root, "vendor/tiny-add"), join(root, "node_modules/tiny-add"));
  const spec = loadPublicApi(root, "tiny-add");
  assert.equal(spec.source, "bundled-dts");
  assert.match(spec.text, /export function add/);
  assert.doesNotMatch(spec.text, new RegExp(SENTINEL));
});
