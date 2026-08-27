import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SlimExit, EXIT_FAIL, EXIT_ENV } from "../src/exit.ts";
import * as githubPr from "../src/github/pr.ts";
import { shouldRefreshLockfile } from "../src/rewrite/lockfile.ts";
import {
  assertNoPollutionDependence,
  runMergeGate,
  shouldRunMergeGate,
  writeTracesMeta,
} from "../src/replace.ts";
import type { TraceEvent } from "../src/envelope/types.ts";
import { plantReplaceTxn } from "./helpers/pr-txn.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("gitignore ignores traces only, not envelopes", () => {
  const gi = readFileSync(join(REPO_ROOT, ".gitignore"), "utf8");
  const lines = gi.split(/\r?\n/).map((l) => l.trim());
  assert.equal(lines.includes("/.slim/"), false);
  assert.equal(lines.includes(".slim/"), false);
  assert.ok(lines.includes(".slim/**/traces.jsonl"));
  assert.ok(lines.includes(".slim/**/traces/"));
  assert.ok(lines.includes(".slim/vitest.trace.ts"));
});

test("shouldRefreshLockfile: --no-install skips lockfile only", () => {
  assert.equal(shouldRefreshLockfile({ keepOriginal: false, noInstall: false }), true);
  assert.equal(shouldRefreshLockfile({ keepOriginal: false, noInstall: true }), false);
  assert.equal(shouldRefreshLockfile({ keepOriginal: true, noInstall: false }), false);
  assert.equal(shouldRefreshLockfile({ keepOriginal: true, noInstall: true }), false);
});

test("writeTracesMeta always writes uploaded:false sidecar", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-traces-meta-"));
  const pkgDir = join(dir, ".slim", "lodash");
  writeTracesMeta(pkgDir);
  const metaPath = join(pkgDir, "traces.meta.json");
  assert.equal(existsSync(metaPath), true);
  assert.deepEqual(JSON.parse(readFileSync(metaPath, "utf8")), { uploaded: false });
});

test("shouldRunMergeGate skips dry-run", () => {
  assert.equal(shouldRunMergeGate({ dryRun: true }), false);
  assert.equal(shouldRunMergeGate({ dryRun: false }), true);
});

test("runMergeGate skips when there is no test script", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-gate-none-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "none", scripts: { build: "echo hi" } }));
  runMergeGate(dir, null);
});

test("runMergeGate uses config.testCommand over package.json scripts.test", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-gate-cmd-"));
  writeFileSync(join(dir, "ok.js"), "process.exit(0);\n");
  writeFileSync(join(dir, "fail.js"), "process.exit(2);\n");
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "gate", scripts: { test: "node ok.js" } }),
  );
  assert.throws(
    () => runMergeGate(dir, "node fail.js"),
    (err: unknown) => err instanceof SlimExit && err.code === EXIT_FAIL,
  );
});

test("runMergeGate fails loud on nonzero test exit", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-gate-fail-"));
  writeFileSync(join(dir, "fail.js"), "process.exit(1);\n");
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "gate", scripts: { test: "node fail.js" } }),
  );
  assert.throws(
    () => runMergeGate(dir, null),
    (err: unknown) =>
      err instanceof SlimExit &&
      err.code === EXIT_FAIL &&
      /merge gate/i.test(err.message),
  );
});

test("runMergeGate passes when scripts.test exits 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-gate-ok-"));
  writeFileSync(join(dir, "ok.js"), "process.exit(0);\n");
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "gate", scripts: { test: "node ok.js" } }),
  );
  runMergeGate(dir, null);
});

test("runMergeGate finds binaries in node_modules/.bin", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-gate-bin-"));
  const bin = join(dir, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  if (process.platform === "win32") {
    writeFileSync(join(bin, "slim-fake-test-runner.cmd"), "@echo off\r\nexit /b 0\r\n");
  } else {
    const runner = join(bin, "slim-fake-test-runner");
    writeFileSync(runner, "#!/bin/sh\nexit 0\n");
    chmodSync(runner, 0o755);
  }
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "gate-bin", scripts: { test: "slim-fake-test-runner" } }),
  );
  runMergeGate(dir, null);
});

test("pollution traces for get/set with __proto__ fail loud (exit 1)", () => {
  const traces: TraceEvent[] = [
    {
      symbol: "get",
      args: [
        { t: "obj", keys: [], v: {} },
        { t: "str", v: "__proto__.polluted" },
      ],
      result: { t: "bool", v: true },
    },
  ];
  assert.throws(
    () => assertNoPollutionDependence(traces),
    (err: unknown) =>
      err instanceof SlimExit &&
      err.code === EXIT_FAIL &&
      /__proto__/i.test(err.message) &&
      /pollut/i.test(err.message),
  );
});

test("canonical set __proto__ path is dependence even with empty mutatedArgIndexes", () => {
  // Tracer snapshot of _.set({}, '__proto__.x', true): own keys unchanged,
  // Object.prototype mutated, result is the empty target.
  const traces: TraceEvent[] = [
    {
      symbol: "set",
      args: [
        { t: "obj", keys: [], v: {} },
        { t: "str", v: "__proto__.x" },
        { t: "bool", v: true },
      ],
      result: { t: "obj", keys: [], v: {} },
      mutatedArgIndexes: [],
    },
  ];
  assert.throws(
    () => assertNoPollutionDependence(traces),
    (err: unknown) =>
      err instanceof SlimExit &&
      err.code === EXIT_FAIL &&
      /__proto__/i.test(err.message),
  );
});

test("get/set traces without __proto__ do not fail", () => {
  const traces: TraceEvent[] = [
    {
      symbol: "get",
      args: [
        { t: "obj", keys: ["a"], v: { a: { t: "num", v: 1 } } },
        { t: "str", v: "a" },
      ],
      result: { t: "num", v: 1 },
    },
  ];
  assertNoPollutionDependence(traces);
});

test("PR requested without gh or token is EXIT_ENV after local writes", async () => {
  assert.equal(typeof githubPr.maybeCreatePullRequest, "function");
  const opts = plantReplaceTxn();
  await assert.rejects(
    () =>
      githubPr.maybeCreatePullRequest(
        true,
        opts,
        {
          hasGh: () => false,
          env: {},
          execFile: (file, args = []) => {
            if (file === "git" && args[0] === "show-ref") {
              throw Object.assign(new Error("not a valid ref"), { status: 1 });
            }
            if (file === "git" && args[0] === "remote") return "git@github.com:acme/app.git\n";
            if (file === "git" && args[0] === "rev-parse") return "abc\n";
            if (file === "git" && args[0] === "ls-remote") return "";
            return "";
          },
          fetchImpl: async () => new Response("no"),
        },
      ),
    (err: unknown) =>
      err instanceof SlimExit &&
      err.code === EXIT_ENV &&
      /install GitHub CLI/i.test(err.message) &&
      /GITHUB_TOKEN/.test(err.message),
  );
});

test("--no-pr never attempts PR and does not throw EXIT_ENV", async () => {
  assert.equal(typeof githubPr.maybeCreatePullRequest, "function");
  const result = await githubPr.maybeCreatePullRequest(
    false,
    { root: "/tmp", title: "t", body: "b", branch: "slim/x", files: ["src/slim/x.ts"], labels: ["slim", "slim:replace"] },
    {
      hasGh: () => false,
      env: {},
      execFile: () => {
        throw new Error("should not exec");
      },
      fetchImpl: async () => {
        throw new Error("should not fetch");
      },
    },
  );
  assert.equal(result, null);
});

test("runReplace awaits PR after writes and does not swallow EXIT_ENV", () => {
  const src = readFileSync(join(REPO_ROOT, "src/replace.ts"), "utf8");
  assert.match(src, /await maybeCreatePullRequest\(!args\.noPr/);
  assert.match(src, /txn\.mutatedPaths\(\)/);
  assert.match(src, /files:\s*slimFiles/);
  const beforePr = src.slice(0, src.lastIndexOf("if (!args.noPr)"));
  assert.match(beforePr, /runMergeGate/);
  assert.match(beforePr, /txn\.commit\(\)/);
  const prSection = src.slice(src.lastIndexOf("if (!args.noPr)"));
  const beforeReturn = prSection.split("return EXIT_OK")[0] ?? "";
  assert.equal(/try\s*\{/.test(beforeReturn), false);
});

test("get/set path segment __proto__ is dependence regardless of result", () => {
  const traces: TraceEvent[] = [
    {
      symbol: "get",
      args: [
        { t: "obj", keys: [], v: {} },
        { t: "arr", v: [{ t: "str", v: "__proto__" }, { t: "str", v: "x" }], holes: [] },
      ],
      result: { t: "undef" },
    },
  ];
  assert.throws(
    () => assertNoPollutionDependence(traces),
    (err: unknown) => err instanceof SlimExit && err.code === EXIT_FAIL,
  );
});
