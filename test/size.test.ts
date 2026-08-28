import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirSize, estimatePackageSize } from "../src/size/estimate.ts";

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "slim-size-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

test("dirSize over the file cap is incomplete and not measured", () => {
  const root = tree({
    "a.txt": "aaaa",
    "b.txt": "bbbb",
    "c.txt": "cccc",
    "d.txt": "dddd",
    "e.txt": "eeee",
  });
  const walked = dirSize(root, 2);
  assert.equal(walked.complete, false);
  assert.match(walked.reason, /cap|limit/i);
  assert.ok(walked.bytes >= 0);
});

test("dangling symlink makes dirSize incomplete", () => {
  const root = mkdtempSync(join(tmpdir(), "slim-size-link-"));
  writeFileSync(join(root, "ok.txt"), "hello");
  symlinkSync(join(root, "missing-target"), join(root, "broken"));
  const walked = dirSize(root);
  assert.equal(walked.complete, false);
  assert.match(walked.reason, /symlink|unreadable|stat/i);
});

test("a small complete tree is measured and repeatable", () => {
  const root = tree({
    "package.json": JSON.stringify({ name: "tiny-pkg", version: "1.0.0" }),
    "index.js": "module.exports = 1;\n",
  });
  const a = dirSize(root);
  const b = dirSize(root);
  assert.equal(a.complete, true);
  assert.equal(a.reason, "");
  assert.equal(a.bytes, b.bytes);
  assert.ok(a.bytes > 0);
});

test("estimatePackageSize uses partial not measured when the walk is capped", () => {
  const project = mkdtempSync(join(tmpdir(), "slim-size-proj-"));
  const nm = join(project, "node_modules", "uncapped-pkg");
  mkdirSync(nm, { recursive: true });
  for (let i = 0; i < 8; i++) writeFileSync(join(nm, `f${i}.txt`), "xxxx");
  const size = estimatePackageSize(project, "uncapped-pkg", { capFiles: 2 });
  assert.equal(size.source, "partial");
  assert.ok(size.minBytes != null);
});

test("known-min packages stay estimated even when unpacked bytes exist", () => {
  const project = mkdtempSync(join(tmpdir(), "slim-size-lodash-"));
  const nm = join(project, "node_modules", "lodash");
  mkdirSync(nm, { recursive: true });
  writeFileSync(join(nm, "index.js"), "module.exports = {};\n");
  const size = estimatePackageSize(project, "lodash");
  assert.equal(size.source, "estimated");
  assert.equal(size.minBytes, 71_000);
});

test("known-min packages stay partial when a dangling symlink blocks a complete walk", () => {
  const project = mkdtempSync(join(tmpdir(), "slim-size-lodash-link-"));
  const nm = join(project, "node_modules", "lodash");
  mkdirSync(nm, { recursive: true });
  writeFileSync(join(nm, "index.js"), "module.exports = {};\n");
  symlinkSync(join(nm, "missing-target"), join(nm, "broken"));
  const size = estimatePackageSize(project, "lodash");
  assert.equal(size.source, "partial");
  assert.equal(size.minBytes, 71_000);
  assert.match(size.reason, /symlink|unreadable/i);
});

test("known-min packages stay partial when the walk hits the file cap", () => {
  const project = mkdtempSync(join(tmpdir(), "slim-size-lodash-cap-"));
  const nm = join(project, "node_modules", "lodash");
  mkdirSync(nm, { recursive: true });
  for (let i = 0; i < 8; i++) writeFileSync(join(nm, `f${i}.txt`), "xxxx");
  const size = estimatePackageSize(project, "lodash", { capFiles: 2 });
  assert.equal(size.source, "partial");
  assert.equal(size.minBytes, 71_000);
  assert.match(size.reason, /cap|limit/i);
});

test("known-min packages stay unknown when the install is missing", () => {
  const project = mkdtempSync(join(tmpdir(), "slim-size-lodash-missing-"));
  mkdirSync(join(project, "node_modules"), { recursive: true });
  const size = estimatePackageSize(project, "lodash");
  assert.equal(size.source, "unknown");
  assert.equal(size.minBytes, 71_000);
  assert.match(size.reason, /not installed/i);
});

test("missing install without a known min is unknown", () => {
  const project = mkdtempSync(join(tmpdir(), "slim-size-missing-"));
  mkdirSync(join(project, "node_modules"), { recursive: true });
  const size = estimatePackageSize(project, "no-such-pkg-zzzz");
  assert.equal(size.source, "unknown");
  assert.equal(size.minBytes, null);
});

test("nested node_modules is skipped and the walk stays complete", () => {
  const root = tree({
    "package.json": JSON.stringify({ name: "pkg", version: "1.0.0" }),
    "index.js": "module.exports = 1;\n",
    "node_modules/other/big.bin": "x".repeat(10_000),
  });
  const walked = dirSize(root);
  assert.equal(walked.complete, true);
  const nested = join(root, "node_modules", "other", "big.bin");
  assert.ok(walked.bytes < statSync(nested).size);
});

test("escaping file symlink is incomplete not measured", () => {
  const outside = mkdtempSync(join(tmpdir(), "slim-size-out-"));
  writeFileSync(join(outside, "secret.bin"), "SECRET");
  const root = mkdtempSync(join(tmpdir(), "slim-size-esc-"));
  writeFileSync(join(root, "ok.txt"), "ok");
  symlinkSync(join(outside, "secret.bin"), join(root, "link.bin"));
  const walked = dirSize(root);
  assert.equal(walked.complete, false);
  assert.match(walked.reason, /symlink|escape/i);
});
