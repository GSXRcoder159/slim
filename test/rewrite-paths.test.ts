import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT_FAIL, EXIT_USAGE, SlimExit } from "../src/exit.ts";
import {
  assertInsideRoot,
  assertNoOutputCollision,
  fileBase,
  isSafeToRewrite,
} from "../src/rewrite/paths.ts";

test("fileBase strips scope and replaces slashes", () => {
  assert.equal(fileBase("ms"), "ms");
  assert.equal(fileBase("@scope/pkg"), "scope-pkg");
});

test("assertInsideRoot accepts a path under root", () => {
  const root = mkdtempSync(join(tmpdir(), "slim-path-ok-"));
  mkdirSync(join(root, "src"), { recursive: true });
  assert.equal(assertInsideRoot(root, "src/slim"), join(root, "src", "slim"));
});

test("assertInsideRoot refuses ../ escape", () => {
  const root = mkdtempSync(join(tmpdir(), "slim-path-esc-"));
  mkdirSync(root, { recursive: true });
  assert.throws(
    () => assertInsideRoot(root, "../elsewhere"),
    (e: unknown) => e instanceof SlimExit && e.code === EXIT_USAGE && /inside the project root/i.test(e.message),
  );
});

test("isSafeToRewrite skips a symlink that escapes the project", () => {
  const root = mkdtempSync(join(tmpdir(), "slim-sym-"));
  const outside = mkdtempSync(join(tmpdir(), "slim-sym-out-"));
  writeFileSync(join(outside, "secret.ts"), 'import x from "ms";\n');
  symlinkSync(join(outside, "secret.ts"), join(root, "link.ts"));
  writeFileSync(join(root, "ok.ts"), "export const n = 1;\n");
  assert.equal(isSafeToRewrite(root, join(root, "ok.ts")), true);
  assert.equal(isSafeToRewrite(root, join(root, "link.ts")), false);
});

test("assertNoOutputCollision refuses a different package at the same module path", () => {
  const root = mkdtempSync(join(tmpdir(), "slim-col-"));
  mkdirSync(join(root, ".slim"), { recursive: true });
  mkdirSync(join(root, "src", "slim"), { recursive: true });
  writeFileSync(join(root, "src", "slim", "ms.ts"), "export {}\n");
  writeFileSync(
    join(root, ".slim", "manifest.json"),
    JSON.stringify({ replacements: { leftpad: { module: "src/slim/ms.ts" } } }, null, 2),
  );
  assert.throws(
    () => assertNoOutputCollision(root, join(root, "src", "slim", "ms.ts"), "ms"),
    (e: unknown) => e instanceof SlimExit && e.code === EXIT_FAIL && /collision/i.test(e.message),
  );
});

test("assertNoOutputCollision allows overwrite of the same package", () => {
  const root = mkdtempSync(join(tmpdir(), "slim-col-ok-"));
  mkdirSync(join(root, ".slim"), { recursive: true });
  mkdirSync(join(root, "src", "slim"), { recursive: true });
  writeFileSync(join(root, "src", "slim", "ms.ts"), "export {}\n");
  writeFileSync(
    join(root, ".slim", "manifest.json"),
    JSON.stringify({ replacements: { ms: { module: "src/slim/ms.ts" } } }, null, 2),
  );
  assertNoOutputCollision(root, join(root, "src", "slim", "ms.ts"), "ms");
});
