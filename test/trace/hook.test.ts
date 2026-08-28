import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
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
  assert.equal(
    matchesTracedUrl("D:\\tmp\\app\\node_modules\\tiny-trace-star\\index.js", ["tiny-trace-star"]),
    true,
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
  const text = readFileSync(outPath, "utf8");
  assert.match(text, /"t":"session"/);
  assert.match(text, /"hook":true/);
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
  assert.match(String(wrapped), /file:/);
  assert.doesNotMatch(String(wrapped), /from ["']slim\/vitest["']/);
  assert.doesNotMatch(String(wrapped), /export \* from/);
  assert.equal(plugin.load?.(origId) ?? null, null);
  assert.equal(plugin.transform?.("", wrapId) ?? null, null);
});

test("slim/vitest wrapper for export * barrel emits named export const", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-vitest-star-"));
  const pkgDir = join(dir, "node_modules", "tiny-trace-star");
  mkdirSync(pkgDir, { recursive: true });
  cpSync(join(dirname(fileURLToPath(import.meta.url)), "../fixtures/trace/esm-star"), pkgDir, {
    recursive: true,
  });
  const plugin = slimVitest({ packages: ["tiny-trace-star"] });
  const wrapId = join(pkgDir, "index.js");
  const wrapped = String(plugin.load?.(wrapId) ?? "");
  assert.match(wrapped, /export const add = wrapped\["add"\]/);
  assert.match(wrapped, /export const get = wrapped\["get"\]/);
  assert.doesNotMatch(wrapped, /export \* from/);
});

test("registerHooks wraps a tiny ESM package under --import", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-hook-esm-"));
  const pkgDir = join(dir, "node_modules", "tiny-trace-esm");
  mkdirSync(pkgDir, { recursive: true });
  const fixture = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/trace/esm");
  cpSync(fixture, pkgDir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "app", type: "module", scripts: { test: "node --test src/index.test.js" } }),
  );
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "src", "index.test.js"),
    `import { test } from "node:test";
import assert from "node:assert/strict";
import { add } from "tiny-trace-esm";
test("add", () => { assert.equal(add(2, 3), 5); });
`,
  );
  const outPath = join(dir, "traces.jsonl");
  const hook = join(dirname(fileURLToPath(import.meta.url)), "../../src/trace/hook.ts");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SLIM_TRACE_PACKAGES: "tiny-trace-esm",
    SLIM_TRACE_OUT: outPath,
  };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_CHANNEL_FD;
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--import", pathToFileURL(hook).href, "--test", "src/index.test.js"],
    { cwd: dir, encoding: "utf8", env },
  );
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const jsonl = readFileSync(outPath, "utf8");
  assert.match(jsonl, /"t":"session"/);
  assert.match(jsonl, /"symbol":"add"/);
});
