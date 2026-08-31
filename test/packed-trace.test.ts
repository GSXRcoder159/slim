import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cmdShimSpawnOpts, execPm, hermeticPmEnv } from "../src/rewrite/lockfile.ts";
import { npmPackTo, installPackedTarball } from "./helpers/llm-replace.ts";
import { packageNodeModulesDir } from "../src/release/identity.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = tmpdir();
const SRC_HOOK = join(ROOT, "src/trace/hook.ts");

let packDir = "";
let tarball = "";
let slimHome = "";
let packedHook = "";
let packedVitest = "";

function run(
  bin: string,
  args: string[],
  cwd: string,
  extraEnv: NodeJS.ProcessEnv = {},
  timeoutMs = 180_000,
): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(bin, args, {
    cwd,
    encoding: "utf8",
    env: hermeticPmEnv({ ...extraEnv }),
    timeout: timeoutMs,
    ...cmdShimSpawnOpts(bin),
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function slimJs(cwd: string): string {
  return join(packageNodeModulesDir(cwd), "dist", "main.js");
}

function installSlim(cwd: string): void {
  installPackedTarball(cwd, tarball);
}

function canonicalizeTraces(jsonl: string): unknown[] {
  return jsonl
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const o = JSON.parse(line) as Record<string, unknown>;
      if (o.t === "session") return { t: "session", hook: o.hook, v: o.v };
      delete o.sessionId;
      delete o.originId;
      delete o.parentOriginId;
      delete o.tRelMs;
      if (o.site && typeof o.site === "object") {
        const s = o.site as { line: number; column: number };
        o.site = { line: s.line, column: s.column };
      }
      return o;
    });
}

function captureHook(
  hookPath: string,
  cwd: string,
  outPath: string,
  extraArgs: string[],
  pkg: string,
): unknown[] {
  const r = run(
    process.execPath,
    [...extraArgs, "--import", pathToFileURL(hookPath).href, "--test", "src/index.test.js"],
    cwd,
    { SLIM_TRACE_PACKAGES: pkg, SLIM_TRACE_OUT: outPath },
  );
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return canonicalizeTraces(readFileSync(outPath, "utf8"));
}

function assertSourceEqualsPacked(dir: string, pkg: string): void {
  const src = captureHook(
    SRC_HOOK,
    dir,
    join(dir, "traces-src.jsonl"),
    ["--experimental-strip-types"],
    pkg,
  );
  const packed = captureHook(packedHook, dir, join(dir, "traces-pkg.jsonl"), [], pkg);
  assert.deepEqual(packed, src);
  assert.equal(
    src.some((e) => typeof e === "object" && e !== null && (e as { symbol?: string }).symbol),
    true,
  );
}

function writeEsmApp(dir: string, pkg: string, fixture: string, testSrc: string): void {
  const pkgDir = join(dir, "node_modules", pkg);
  mkdirSync(pkgDir, { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  cpSync(join(ROOT, "test/fixtures/trace", fixture), pkgDir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "app", type: "module" }));
  writeFileSync(join(dir, "src", "index.test.js"), testSrc);
}

function assertHygiene(root: string, pkg: string): void {
  const dir = join(root, ".slim", pkg);
  assert.ok(existsSync(join(dir, "traces.meta.json")));
  assert.equal(JSON.parse(readFileSync(join(dir, "traces.meta.json"), "utf8")).uploaded, false);
  assert.equal(existsSync(join(dir, "traces.jsonl")), false);
  const env = JSON.parse(readFileSync(join(dir, "envelope.json"), "utf8")) as {
    traces: unknown[];
    closure: { confidence: string; reason: string };
  };
  assert.deepEqual(env.traces, []);
  assert.notEqual(env.closure.confidence, "trace-closed");
  assert.doesNotMatch(env.closure.reason, /--no-trace/);
  const blob =
    readFileSync(join(dir, "evidence.md"), "utf8") + readFileSync(join(dir, "evidence.json"), "utf8");
  assert.doesNotMatch(blob, /traces\.jsonl/);
  assert.doesNotMatch(blob, /"t":"session"/);
  assert.doesNotMatch(blob, /at foo \(/);
  assert.doesNotMatch(blob, /sourcesContent/);
  assert.doesNotMatch(blob, /super-secret|sk-ant-/);
  assert.doesNotMatch(blob, /--no-trace/);
  const files = readdirSync(root, { recursive: true }).map(String);
  assert.equal(files.some((f) => f.replace(/\\/g, "/").endsWith("traces.jsonl")), false);
}

before(() => {
  if (!existsSync(join(ROOT, "dist", ".slim-build.json"))) {
    execPm("npm", ["run", "build"], { cwd: ROOT, encoding: "utf8", timeout: 240_000 });
  }
  packDir = mkdtempSync(join(TMP, "slim-p4-pack-"));
  tarball = npmPackTo(packDir);
  slimHome = mkdtempSync(join(TMP, "slim-p4-home-"));
  writeFileSync(join(slimHome, "package.json"), JSON.stringify({ name: "slim-home", private: true }));
  installSlim(slimHome);
  packedHook = join(packageNodeModulesDir(slimHome), "dist", "trace", "hook.js");
  packedVitest = join(packageNodeModulesDir(slimHome), "dist", "trace", "vitest.js");
  assert.ok(existsSync(packedHook), "packed hook.js missing");
  assert.ok(existsSync(packedVitest), "packed vitest.js missing");
  assert.ok(existsSync(join(packageNodeModulesDir(slimHome), "dist", "trace", "match.js")));
});

after(() => {
  if (slimHome) rmSync(slimHome, { recursive: true, force: true });
  if (packDir) rmSync(packDir, { recursive: true, force: true });
});

test("source-installed and packed-installed hooks emit the same event schema", { timeout: 180_000 }, () => {
  const named = mkdtempSync(join(TMP, "slim-p4-pack-named-"));
  writeEsmApp(
    named,
    "tiny-trace-esm",
    "esm",
    `import { test } from "node:test";
import assert from "node:assert/strict";
import { add } from "tiny-trace-esm";
test("add", () => { assert.equal(add(2, 3), 5); });
`,
  );
  assertSourceEqualsPacked(named, "tiny-trace-esm");

  const def = mkdtempSync(join(TMP, "slim-p4-pack-def-"));
  writeEsmApp(
    def,
    "tiny-trace-default",
    "esm-default",
    `import { test } from "node:test";
import assert from "node:assert/strict";
import add from "tiny-trace-default";
test("default", () => { assert.equal(add(2, 3), 5); });
`,
  );
  assertSourceEqualsPacked(def, "tiny-trace-default");

  const ns = mkdtempSync(join(TMP, "slim-p4-pack-ns-"));
  writeEsmApp(
    ns,
    "tiny-trace-ns",
    "esm-ns",
    `import { test } from "node:test";
import assert from "node:assert/strict";
import { ns } from "tiny-trace-ns";
test("ns", () => { assert.equal(ns.add(2, 3), 5); });
`,
  );
  assertSourceEqualsPacked(ns, "tiny-trace-ns");

  const list = mkdtempSync(join(TMP, "slim-p4-pack-list-"));
  writeEsmApp(
    list,
    "tiny-trace-list",
    "esm-list",
    `import { test } from "node:test";
import assert from "node:assert/strict";
import { add, get } from "tiny-trace-list";
test("list", () => {
  assert.equal(add(2, 3), 5);
  assert.equal(get({ a: 1 }, "a"), 1);
});
`,
  );
  assertSourceEqualsPacked(list, "tiny-trace-list");

  const star = mkdtempSync(join(TMP, "slim-p4-pack-star-"));
  writeEsmApp(
    star,
    "tiny-trace-star",
    "esm-star",
    `import { test } from "node:test";
import assert from "node:assert/strict";
import { add } from "tiny-trace-star";
test("star", () => { assert.equal(add(2, 3), 5); });
`,
  );
  assertSourceEqualsPacked(star, "tiny-trace-star");

  const cjs = mkdtempSync(join(TMP, "slim-p4-pack-cjs-"));
  mkdirSync(join(cjs, "node_modules", "tiny-trace-cjs"), { recursive: true });
  mkdirSync(join(cjs, "src"), { recursive: true });
  cpSync(join(ROOT, "test/fixtures/trace/cjs"), join(cjs, "node_modules", "tiny-trace-cjs"), {
    recursive: true,
  });
  writeFileSync(join(cjs, "package.json"), JSON.stringify({ name: "app", type: "commonjs" }));
  writeFileSync(
    join(cjs, "src", "index.test.js"),
    `const { test } = require("node:test");
const assert = require("node:assert/strict");
const { add } = require("tiny-trace-cjs");
test("add", () => { assert.equal(add(2, 3), 5); });
`,
  );
  assertSourceEqualsPacked(cjs, "tiny-trace-cjs");

  const worker = mkdtempSync(join(TMP, "slim-p4-pack-worker-"));
  mkdirSync(join(worker, "node_modules", "tiny-trace-worker"), { recursive: true });
  mkdirSync(join(worker, "src"), { recursive: true });
  cpSync(join(ROOT, "test/fixtures/trace/worker"), join(worker, "node_modules", "tiny-trace-worker"), {
    recursive: true,
  });
  writeFileSync(join(worker, "package.json"), JSON.stringify({ name: "app", type: "commonjs" }));
  writeFileSync(
    join(worker, "src", "worker.cjs"),
    `const { parentPort } = require("node:worker_threads");
const { add } = require("tiny-trace-worker");
parentPort.postMessage(add(2, 3));
`,
  );
  writeFileSync(
    join(worker, "src", "index.test.js"),
    `const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Worker } = require("node:worker_threads");
const { join } = require("node:path");
test("worker add", async () => {
  const w = new Worker(join(__dirname, "worker.cjs"), { execArgv: [] });
  const n = await new Promise((resolve, reject) => {
    w.once("message", resolve);
    w.once("error", reject);
  });
  assert.equal(n, 5);
  await w.terminate();
});
`,
  );
  assertSourceEqualsPacked(worker, "tiny-trace-worker");
});

test("packed node:test ESM replace traces without --no-trace", { timeout: 180_000 }, () => {
  const dest = mkdtempSync(join(TMP, "slim-p4-esm-rep-"));
  mkdirSync(join(dest, "src"), { recursive: true });
  writeFileSync(
    join(dest, "package.json"),
    JSON.stringify({
      name: "esm-app",
      private: true,
      type: "module",
      scripts: { test: "node --experimental-strip-types --test src/index.test.ts" },
      dependencies: { ms: "2.1.3" },
      devDependencies: { typescript: "^5.9.2" },
    }) + "\n",
  );
  writeFileSync(
    join(dest, "src", "index.ts"),
    `import ms from "ms";\nexport function hour(): number { return ms("1h") as number; }\n`,
  );
  writeFileSync(
    join(dest, "src", "index.test.ts"),
    `import { test } from "node:test";
import assert from "node:assert/strict";
import { hour } from "./index.ts";
test("hour", () => { assert.equal(hour(), 3600000); });
`,
  );
  installSlim(dest);
  const args = ["replace", "ms", "--no-pr", "--budget-ms", "800", "--workers", "1"];
  assert.equal(args.includes("--no-trace"), false);
  const replaced = run(process.execPath, [slimJs(dest), ...args], dest);
  assert.equal(replaced.status, 0, replaced.stderr + replaced.stdout);
  assertHygiene(dest, "ms");
});

test("packed node:test CJS replace traces without --no-trace", { timeout: 180_000 }, () => {
  const dest = mkdtempSync(join(TMP, "slim-p4-cjs-rep-"));
  mkdirSync(join(dest, "src"), { recursive: true });
  writeFileSync(
    join(dest, "package.json"),
    JSON.stringify({
      name: "cjs-app",
      private: true,
      scripts: { test: "node --test src/index.test.js" },
      dependencies: { ms: "2.1.3" },
      devDependencies: { typescript: "^5.9.2" },
    }) + "\n",
  );
  writeFileSync(
    join(dest, "src", "index.js"),
    `const ms = require("ms");\nmodule.exports = { hour: () => ms("1h") };\n`,
  );
  writeFileSync(
    join(dest, "src", "index.test.js"),
    `const { test } = require("node:test");
const assert = require("node:assert/strict");
const { hour } = require("./index.js");
test("hour", () => assert.equal(hour(), 3600000));
`,
  );
  installSlim(dest);
  const args = ["replace", "ms", "--no-pr", "--budget-ms", "800", "--workers", "1"];
  assert.equal(args.includes("--no-trace"), false);
  const replaced = run(process.execPath, [slimJs(dest), ...args], dest);
  assert.equal(replaced.status, 0, replaced.stderr + replaced.stdout);
  assertHygiene(dest, "ms");
});

test("packed Vitest replace traces without --no-trace", { timeout: 300_000 }, () => {
  const dest = mkdtempSync(join(TMP, "slim-p4-vitest-rep-"));
  mkdirSync(join(dest, "src"), { recursive: true });
  writeFileSync(
    join(dest, "package.json"),
    JSON.stringify({
      name: "vitest-app",
      private: true,
      type: "module",
      scripts: { test: "vitest run" },
      dependencies: { ms: "2.1.3" },
      devDependencies: { typescript: "^5.9.2" },
    }) + "\n",
  );
  writeFileSync(
    join(dest, "src", "index.ts"),
    `import ms from "ms";\nexport function hour(): number { return ms("1h") as number; }\n`,
  );
  writeFileSync(
    join(dest, "src", "hour.test.ts"),
    `import { test, expect } from "vitest";
import { hour } from "./index.ts";
test("hour", () => expect(hour()).toBe(3600000));
`,
  );
  installSlim(dest);
  execPm("npm", ["install", "vitest@3.2.4", "--save-dev", "--no-audit", "--no-fund"], {
    cwd: dest,
    encoding: "utf8",
    timeout: 120_000,
    env: hermeticPmEnv(),
  });
  const args = ["replace", "ms", "--no-pr", "--budget-ms", "800", "--workers", "1"];
  assert.equal(args.includes("--no-trace"), false);
  const replaced = run(process.execPath, [slimJs(dest), ...args], dest, {}, 240_000);
  assert.equal(replaced.status, 0, replaced.stderr + replaced.stdout);
  assert.doesNotMatch(replaced.stdout + replaced.stderr, /--no-trace/);
  assertHygiene(dest, "ms");
});

test("packed CLI Jest detect-only exits 4", { timeout: 180_000 }, () => {
  const dest = mkdtempSync(join(TMP, "slim-p4-jest-"));
  mkdirSync(join(dest, "src"), { recursive: true });
  writeFileSync(
    join(dest, "package.json"),
    JSON.stringify({
      name: "jest-app",
      private: true,
      type: "module",
      scripts: { test: "jest" },
      dependencies: { ms: "2.1.3" },
      devDependencies: { typescript: "^5.9.2" },
    }) + "\n",
  );
  writeFileSync(
    join(dest, "src", "index.ts"),
    `import ms from "ms";\nexport function hour(): number { return ms("1h") as number; }\n`,
  );
  installSlim(dest);
  const replaced = run(process.execPath, [slimJs(dest), "replace", "ms", "--no-pr"], dest);
  assert.equal(replaced.status, 4, replaced.stderr + replaced.stdout);
  assert.match(replaced.stderr + replaced.stdout, /Jest is detect-only/);
});

test("packed CLI no runner exits 4", { timeout: 180_000 }, () => {
  const dest = mkdtempSync(join(TMP, "slim-p4-norun-"));
  mkdirSync(join(dest, "src"), { recursive: true });
  writeFileSync(
    join(dest, "package.json"),
    JSON.stringify({
      name: "none-app",
      private: true,
      type: "module",
      dependencies: { ms: "2.1.3" },
      devDependencies: { typescript: "^5.9.2" },
    }) + "\n",
  );
  writeFileSync(
    join(dest, "src", "index.ts"),
    `import ms from "ms";\nexport function hour(): number { return ms("1h") as number; }\n`,
  );
  installSlim(dest);
  const replaced = run(process.execPath, [slimJs(dest), "replace", "ms", "--no-pr"], dest);
  assert.equal(replaced.status, 4, replaced.stderr + replaced.stdout);
  assert.match(replaced.stderr + replaced.stdout, /no test runner/);
});

test("packed CLI zero package events exits 1", { timeout: 180_000 }, () => {
  const dest = mkdtempSync(join(TMP, "slim-p4-zero-"));
  mkdirSync(join(dest, "src"), { recursive: true });
  writeFileSync(
    join(dest, "package.json"),
    JSON.stringify({
      name: "zero-app",
      private: true,
      type: "module",
      scripts: { test: "node --experimental-strip-types --test src/index.test.ts" },
      dependencies: { ms: "2.1.3" },
      devDependencies: { typescript: "^5.9.2" },
    }) + "\n",
  );
  writeFileSync(
    join(dest, "src", "index.ts"),
    `import ms from "ms";\nexport function hour(): number { return ms("1h") as number; }\n`,
  );
  writeFileSync(
    join(dest, "src", "index.test.ts"),
    `import { test } from "node:test";
import assert from "node:assert/strict";
test("math", () => { assert.equal(1 + 1, 2); });
`,
  );
  installSlim(dest);
  const replaced = run(process.execPath, [slimJs(dest), "replace", "ms", "--no-pr"], dest);
  assert.equal(replaced.status, 1, replaced.stderr + replaced.stdout);
  assert.match(replaced.stderr + replaced.stdout, /not observed|zero package events/);
});

test("packed missing hook.js exits 4", { timeout: 180_000 }, () => {
  const dest = mkdtempSync(join(TMP, "slim-p4-misshook-"));
  mkdirSync(join(dest, "src"), { recursive: true });
  writeFileSync(
    join(dest, "package.json"),
    JSON.stringify({
      name: "hookless-app",
      private: true,
      type: "module",
      scripts: { test: "node --experimental-strip-types --test src/index.test.ts" },
      dependencies: { ms: "2.1.3" },
      devDependencies: { typescript: "^5.9.2" },
    }) + "\n",
  );
  writeFileSync(
    join(dest, "src", "index.ts"),
    `import ms from "ms";\nexport function hour(): number { return ms("1h") as number; }\n`,
  );
  writeFileSync(
    join(dest, "src", "index.test.ts"),
    `import { test } from "node:test";
import assert from "node:assert/strict";
import { hour } from "./index.ts";
test("hour", () => { assert.equal(hour(), 3600000); });
`,
  );
  installSlim(dest);
  unlinkSync(join(packageNodeModulesDir(dest), "dist", "trace", "hook.js"));
  const replaced = run(process.execPath, [slimJs(dest), "replace", "ms", "--no-pr"], dest);
  assert.equal(replaced.status, 4, replaced.stderr + replaced.stdout);
  assert.match(replaced.stderr + replaced.stdout, /trace hook missing/);
});
