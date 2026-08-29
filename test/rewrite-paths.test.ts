import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT_FAIL, EXIT_USAGE, SlimExit } from "../src/exit.ts";
import {
  assertGeneratedOutputSafe,
  assertInsideRoot,
  assertNoOutputCollision,
  assertSafeWrite,
  fileBase,
  isSafeToRewrite,
} from "../src/rewrite/paths.ts";

const HASH = "a".repeat(64);

function acceptedManifest(pkg = "ms", module = "src/slim/ms.ts"): string {
  return JSON.stringify(
    {
      schemaVersion: 1,
      replacements: {
        [pkg]: {
          version: "2.1.3",
          envelopeHash: HASH,
          symbols: ["default"],
          module,
        },
      },
    },
    null,
    2,
  );
}

function withSlice(root: string, body = "export {}\n"): string {
  mkdirSync(join(root, "src", "slim"), { recursive: true });
  const slimPath = join(root, "src", "slim", "ms.ts");
  writeFileSync(slimPath, body);
  return slimPath;
}

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

test("isSafeToRewrite is false for a symlink that escapes the project", () => {
  const root = mkdtempSync(join(tmpdir(), "slim-sym-"));
  const outside = mkdtempSync(join(tmpdir(), "slim-sym-out-"));
  writeFileSync(join(outside, "secret.ts"), 'import x from "ms";\n');
  symlinkSync(join(outside, "secret.ts"), join(root, "link.ts"));
  writeFileSync(join(root, "ok.ts"), "export const n = 1;\n");
  assert.equal(isSafeToRewrite(root, join(root, "ok.ts")), true);
  assert.equal(isSafeToRewrite(root, join(root, "link.ts")), false);
});

test("isSafeToRewrite is false for an internal file symlink", () => {
  const root = mkdtempSync(join(tmpdir(), "slim-sym-int-"));
  writeFileSync(join(root, "real.ts"), "export const n = 1;\n");
  symlinkSync("real.ts", join(root, "link.ts"));
  assert.equal(isSafeToRewrite(root, join(root, "link.ts")), false);
});

test("assertInsideRoot refuses a symlinked output directory that escapes", () => {
  const root = mkdtempSync(join(tmpdir(), "slim-out-sym-"));
  const outside = mkdtempSync(join(tmpdir(), "slim-out-sym-dest-"));
  mkdirSync(join(root, "src"), { recursive: true });
  symlinkSync(outside, join(root, "src", "slim"));
  assert.throws(
    () => assertInsideRoot(root, "src/slim"),
    (e: unknown) => e instanceof SlimExit && e.code === EXIT_USAGE && /inside the project root/i.test(e.message),
  );
});

test("assertInsideRoot refuses an internal symlinked output directory", () => {
  const root = mkdtempSync(join(tmpdir(), "slim-out-int-"));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "elsewhere"), { recursive: true });
  writeFileSync(join(root, "elsewhere", "keep.txt"), "keep\n");
  symlinkSync(join(root, "elsewhere"), join(root, "src", "slim"));
  assert.throws(
    () => assertInsideRoot(root, "src/slim"),
    (e: unknown) => e instanceof SlimExit && e.code === EXIT_USAGE && /symlink/i.test(e.message),
  );
  assert.equal(readFileSync(join(root, "elsewhere", "keep.txt"), "utf8"), "keep\n");
});

test("assertInsideRoot refuses a symlink ancestor of --out under the project", () => {
  const root = mkdtempSync(join(tmpdir(), "slim-out-anc-"));
  mkdirSync(join(root, "real-src"), { recursive: true });
  symlinkSync("real-src", join(root, "src"));
  assert.throws(
    () => assertInsideRoot(root, "src/slim"),
    (e: unknown) => e instanceof SlimExit && e.code === EXIT_USAGE && /symlink/i.test(e.message),
  );
});

test("assertSafeWrite refuses an escaping symlink before any write", () => {
  const root = mkdtempSync(join(tmpdir(), "slim-safe-"));
  const outside = mkdtempSync(join(tmpdir(), "slim-safe-out-"));
  writeFileSync(join(outside, "secret.ts"), "secret\n");
  symlinkSync(join(outside, "secret.ts"), join(root, "link.ts"));
  assert.throws(
    () => assertSafeWrite(root, join(root, "link.ts")),
    (e: unknown) => e instanceof SlimExit && e.code === EXIT_USAGE && /escapes the project/i.test(e.message),
  );
});

test("assertSafeWrite refuses an internal file symlink before any write", () => {
  const root = mkdtempSync(join(tmpdir(), "slim-safe-int-"));
  writeFileSync(join(root, "real.ts"), "orig\n");
  symlinkSync("real.ts", join(root, "link.ts"));
  assert.throws(
    () => assertSafeWrite(root, join(root, "link.ts")),
    (e: unknown) => e instanceof SlimExit && e.code === EXIT_USAGE && /is a symlink/i.test(e.message),
  );
  assert.equal(readFileSync(join(root, "real.ts"), "utf8"), "orig\n");
});

test("assertNoOutputCollision refuses a different package at the same module path", () => {
  const root = mkdtempSync(join(tmpdir(), "slim-col-"));
  mkdirSync(join(root, ".slim"), { recursive: true });
  const slimPath = withSlice(root);
  writeFileSync(
    join(root, ".slim", "manifest.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        replacements: {
          leftpad: { version: "1.0.0", envelopeHash: HASH, symbols: ["default"], module: "src/slim/ms.ts" },
        },
      },
      null,
      2,
    ),
  );
  assert.throws(
    () => assertNoOutputCollision(root, slimPath, "ms"),
    (e: unknown) => e instanceof SlimExit && e.code === EXIT_FAIL && /collision/i.test(e.message) && /leftpad/i.test(e.message),
  );
  assert.equal(readFileSync(slimPath, "utf8"), "export {}\n");
});

test("assertNoOutputCollision allows overwrite of the same package", () => {
  const root = mkdtempSync(join(tmpdir(), "slim-col-ok-"));
  mkdirSync(join(root, ".slim"), { recursive: true });
  const slimPath = withSlice(root);
  writeFileSync(join(root, ".slim", "manifest.json"), acceptedManifest());
  assertNoOutputCollision(root, slimPath, "ms");
});

test("assertNoOutputCollision refuses an existing file when no manifest exists", () => {
  const root = mkdtempSync(join(tmpdir(), "slim-col-nom-"));
  const slimPath = withSlice(root, "unrelated\n");
  assert.throws(
    () => assertNoOutputCollision(root, slimPath, "ms"),
    (e: unknown) =>
      e instanceof SlimExit && e.code === EXIT_FAIL && /collision/i.test(e.message) && /not a Slim-owned/i.test(e.message),
  );
  assert.equal(readFileSync(slimPath, "utf8"), "unrelated\n");
});

test("assertNoOutputCollision refuses an existing file when replacements are empty", () => {
  const root = mkdtempSync(join(tmpdir(), "slim-col-empty-"));
  mkdirSync(join(root, ".slim"), { recursive: true });
  const slimPath = withSlice(root, "unrelated\n");
  writeFileSync(
    join(root, ".slim", "manifest.json"),
    JSON.stringify({ schemaVersion: 1, replacements: {} }, null, 2),
  );
  assert.throws(
    () => assertNoOutputCollision(root, slimPath, "ms"),
    (e: unknown) => e instanceof SlimExit && e.code === EXIT_FAIL && /collision/i.test(e.message),
  );
  assert.equal(readFileSync(slimPath, "utf8"), "unrelated\n");
});

test("assertNoOutputCollision refuses an existing file when the manifest is malformed", () => {
  const root = mkdtempSync(join(tmpdir(), "slim-col-bad-"));
  mkdirSync(join(root, ".slim"), { recursive: true });
  const slimPath = withSlice(root, "unrelated\n");
  writeFileSync(join(root, ".slim", "manifest.json"), "{not json");
  assert.throws(
    () => assertNoOutputCollision(root, slimPath, "ms"),
    (e: unknown) => e instanceof SlimExit && e.code === EXIT_FAIL && /collision/i.test(e.message),
  );
  assert.equal(readFileSync(slimPath, "utf8"), "unrelated\n");
});

test("assertNoOutputCollision refuses an incomplete same-package record", () => {
  const root = mkdtempSync(join(tmpdir(), "slim-col-inc-"));
  mkdirSync(join(root, ".slim"), { recursive: true });
  const slimPath = withSlice(root, "unrelated\n");
  writeFileSync(
    join(root, ".slim", "manifest.json"),
    JSON.stringify({ schemaVersion: 1, replacements: { ms: { module: "src/slim/ms.ts" } } }, null, 2),
  );
  assert.throws(
    () => assertNoOutputCollision(root, slimPath, "ms"),
    (e: unknown) => e instanceof SlimExit && e.code === EXIT_FAIL && /collision/i.test(e.message),
  );
  assert.equal(readFileSync(slimPath, "utf8"), "unrelated\n");
});

test("assertGeneratedOutputSafe refuses an unowned standing test next to a missing slice", () => {
  const root = mkdtempSync(join(tmpdir(), "slim-col-stand-"));
  mkdirSync(join(root, "src", "slim"), { recursive: true });
  const slice = join(root, "src", "slim", "ms.ts");
  const standing = join(root, "src", "slim", "ms.test.ts");
  writeFileSync(standing, "unrelated standing\n");
  assert.throws(
    () => assertGeneratedOutputSafe(root, slice, [slice, standing], "ms"),
    (e: unknown) => e instanceof SlimExit && e.code === EXIT_FAIL && /collision/i.test(e.message),
  );
  assert.equal(readFileSync(standing, "utf8"), "unrelated standing\n");
});

test("assertGeneratedOutputSafe allows owned companions on a second replace", () => {
  const root = mkdtempSync(join(tmpdir(), "slim-col-own-"));
  mkdirSync(join(root, ".slim"), { recursive: true });
  const slice = withSlice(root);
  const standing = join(root, "src", "slim", "ms.test.ts");
  writeFileSync(standing, "owned standing\n");
  writeFileSync(join(root, ".slim", "manifest.json"), acceptedManifest());
  assertGeneratedOutputSafe(root, slice, [slice, standing], "ms");
});
