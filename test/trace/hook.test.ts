import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import {
  createSlimHooks,
  matchesTracedUrl,
} from "../../src/trace/hook.ts";
import slimVitest, { slimVitest as namedSlimVitest } from "../../src/trace/vitest.ts";

test("matchesTracedUrl matches lodash but not lodash-es", () => {
  assert.equal(
    matchesTracedUrl("file:///app/node_modules/lodash/lodash.js", ["lodash"]),
    true,
  );
  assert.equal(
    matchesTracedUrl("file:///app/node_modules/lodash-es/get.js", ["lodash"]),
    false,
  );
  assert.equal(
    matchesTracedUrl("file:///app/node_modules/lodash-es/get.js", [
      "lodash-es",
    ]),
    true,
  );
  assert.equal(
    matchesTracedUrl("file:///app/src/index.js", ["lodash"]),
    false,
  );
});

test("createSlimHooks returns register, events, flush", () => {
  const h = createSlimHooks({ packages: ["lodash"] });
  assert.equal(typeof h.register, "function");
  assert.equal(typeof h.events, "function");
  assert.equal(typeof h.flush, "function");
  assert.deepEqual(h.events(), []);
  h.flush();
});

test("createSlimHooks writes JSONL on events via flush sink", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-hooks-"));
  const outPath = join(dir, "traces.jsonl");
  const h = createSlimHooks({ packages: ["lodash"], outPath });
  h.register();
  assert.deepEqual(h.events(), []);
  h.flush();
});

test("registerHooks wraps a tiny local CJS package under node_modules", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-hook-pkg-"));
  const pkgDir = join(dir, "node_modules", "tiny-trace-pkg");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "tiny-trace-pkg", main: "index.js" }),
  );
  writeFileSync(
    join(pkgDir, "index.js"),
    "module.exports = { add(a, b) { return a + b; } };\n",
  );
  const outPath = join(dir, "traces.jsonl");
  writeFileSync(join(dir, "package.json"), "{}");
  const h = createSlimHooks({ packages: ["tiny-trace-pkg"], outPath });
  h.register();
  const req = createRequire(join(dir, "package.json"));
  const mod = req("tiny-trace-pkg") as { add: (a: number, b: number) => number };
  const sum = mod.add(2, 3);
  assert.equal(sum, 5);
  const events = h.events();
  assert.equal(events.length >= 1, true);
  assert.equal(events[0]!.symbol, "add");
  h.flush();
  const jsonl = readFileSync(outPath, "utf8").trim();
  assert.ok(jsonl.length > 0);
});

test("slim/vitest plugin is duck-typed and skips slim-orig", () => {
  assert.equal(typeof slimVitest, "function");
  assert.equal(namedSlimVitest, slimVitest);
  const plugin = slimVitest({ packages: ["lodash"] });
  assert.equal(plugin.name, "slim-vitest");
  const wrapId = "/app/node_modules/lodash/lodash.js";
  const origId = wrapId + "?slim-orig";
  const wrapped = plugin.load?.(wrapId);
  assert.equal(typeof wrapped, "string");
  assert.match(String(wrapped), /wrapExports/);
  assert.match(String(wrapped), /\?slim-orig/);
  assert.equal(plugin.load?.(origId) ?? null, null);
  assert.equal(plugin.transform?.("", wrapId) ?? null, null);
});
