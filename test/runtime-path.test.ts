import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { siblingModule } from "../src/runtime-path.ts";

test("siblingModule prefers .js when both exist", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-sib-"));
  writeFileSync(join(dir, "hook.js"), "export {}\n");
  writeFileSync(join(dir, "hook.ts"), "export {}\n");
  const meta = pathToFileURL(join(dir, "caller.js")).href;
  assert.equal(siblingModule(meta, "hook"), join(dir, "hook.js"));
});

test("siblingModule uses .ts when only source is present", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-sib-"));
  writeFileSync(join(dir, "hook.ts"), "export {}\n");
  const meta = pathToFileURL(join(dir, "caller.ts")).href;
  assert.equal(siblingModule(meta, "hook"), join(dir, "hook.ts"));
});

test("siblingModule resolves nested relative ids", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-sib-"));
  mkdirSync(join(dir, "trace"));
  writeFileSync(join(dir, "trace", "hook.ts"), "export {}\n");
  const meta = pathToFileURL(join(dir, "replace.ts")).href;
  assert.equal(siblingModule(meta, "trace/hook"), join(dir, "trace", "hook.ts"));
});

test("siblingModule throws when neither exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-sib-"));
  const meta = pathToFileURL(join(dir, "caller.js")).href;
  assert.throws(() => siblingModule(meta, "missing"), /runtime file missing/);
});
