import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, unlinkSync, existsSync, openSync, ftruncateSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EXIT_ENV, EXIT_FAIL, SlimExit } from "../../src/exit.ts";
import {
  runTraces,
  readTraceFile,
  withLocalBinPath,
  MAX_TRACE_EVENTS,
  MAX_TRACE_BYTES,
} from "../../src/trace/run.ts";
import { sessionLine } from "../../src/trace/session.ts";
import { siblingModule } from "../../src/runtime-path.ts";
import { execPm } from "../../src/rewrite/lockfile.ts";
import { withRepoDistLock } from "../helpers/llm-replace.ts";
import { ENVELOPE_VERSION, emptyHyrum } from "../../src/envelope/types.ts";
import type { Envelope } from "../../src/envelope/types.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

function emptyEnv(): Envelope {
  return {
    schemaVersion: ENVELOPE_VERSION,
    package: { name: "tiny-trace-pkg", version: "1.0.0", family: "tiny-trace-pkg", subpath: "" },
    env: ["node"],
    imports: [],
    symbols: [
      {
        exportName: "add",
        packages: [],
        callSites: [
          {
            id: "call:src/index.test.js:4",
            loc: { file: "src/index.test.js", line: 4, column: 1, endLine: 4, endColumn: 40 },
            exportName: "add",
            memberPath: [],
            thisBinding: { kind: "unbound" },
            argc: { min: 2, max: 2, observed: [2] },
            argShapes: [],
            spread: false,
            resultMembers: [],
          },
        ],
        resultMembers: [],
        hyrum: emptyHyrum(),
        coverage: { callSitesStatic: 1, callSitesTraced: 0 },
      },
    ],
    unknowns: [],
    traces: [],
    closure: {
      confidence: "closed",
      readyToGenerate: true,
      staticCallSiteIds: ["call:src/index.test.js:4"],
      tracedCallSiteIds: [],
      untracedCallSiteIds: ["call:src/index.test.js:4"],
      reason: "",
    },
    slimmable: { score: 80, verdict: "slim", blockers: [], reasons: [] },
    clock: false,
    cryptoRandom: false,
  };
}

function isExit(err: unknown, code: number): boolean {
  return err instanceof SlimExit && err.code === code;
}

test("jest projects fail closed with detect-only instructions", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-run-jest-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "j", scripts: { test: "jest" }, devDependencies: { jest: "29" } }),
  );
  assert.throws(() => runTraces(dir, "lodash", emptyEnv()), (e: unknown) => isExit(e, EXIT_ENV));
  try {
    runTraces(dir, "lodash", emptyEnv());
  } catch (e) {
    assert.match((e as Error).message, /Jest is detect-only/);
    assert.match((e as Error).message, /--no-trace/);
  }
});

test("no runner fails closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-run-none-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "n", scripts: { build: "echo" } }));
  assert.throws(() => runTraces(dir, "lodash", emptyEnv()), (e: unknown) => isExit(e, EXIT_ENV));
});

test("malformed JSONL fails closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-run-bad-"));
  const p = join(dir, "traces.jsonl");
  writeFileSync(p, sessionLine() + "{not json\n");
  assert.throws(() => readTraceFile(p), (e: unknown) => isExit(e, EXIT_FAIL));
});

test("malformed SlimValue trace payload fails closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-run-value-"));
  const p = join(dir, "traces.jsonl");
  writeFileSync(
    p,
    sessionLine() + JSON.stringify({ symbol: "add", args: [{ t: "obj", keys: [] }] }) + "\n",
  );
  assert.throws(() => readTraceFile(p), (e: unknown) => isExit(e, EXIT_FAIL));
});

test("missing session header fails closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-run-hdr-"));
  const p = join(dir, "traces.jsonl");
  writeFileSync(p, JSON.stringify({ symbol: "add", args: [] }) + "\n");
  const parsed = readTraceFile(p);
  assert.equal(parsed.sawSession, false);
});

test("node:test fixture records events when traces are required", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-run-node-"));
  mkdirSync(join(dir, "node_modules", "tiny-trace-pkg"), { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "node_modules", "tiny-trace-pkg", "package.json"),
    JSON.stringify({ name: "tiny-trace-pkg", main: "index.js" }),
  );
  writeFileSync(
    join(dir, "node_modules", "tiny-trace-pkg", "index.js"),
    "module.exports = { add(a, b) { return a + b; } };\n",
  );
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "app",
      type: "commonjs",
      scripts: { test: "node --test src/index.test.js" },
    }),
  );
  writeFileSync(
    join(dir, "src", "index.js"),
    'const { add } = require("tiny-trace-pkg");\nmodule.exports = { add };\n',
  );
  writeFileSync(
    join(dir, "src", "index.test.js"),
    'const { test } = require("node:test");\nconst assert = require("node:assert/strict");\nconst { add } = require("./index.js");\ntest("add", () => { assert.equal(add(2, 3), 5); });\n',
  );
  const env = emptyEnv();
  const out = runTraces(dir, "tiny-trace-pkg", env);
  assert.ok(out.traces.length >= 1);
  assert.equal(out.traces.some((t) => t.symbol === "add"), true);
});

test("withLocalBinPath strips host test-runner IPC env", () => {
  const env = withLocalBinPath("/tmp/app", {
    PATH: "/bin",
    NODE_TEST_CONTEXT: "child-process",
    NODE_CHANNEL_FD: "3",
    SLIM_TRACE_OUT: "/tmp/t.jsonl",
  });
  assert.equal(env.NODE_TEST_CONTEXT, undefined);
  assert.equal(env.NODE_CHANNEL_FD, undefined);
  assert.equal(env.SLIM_TRACE_OUT, "/tmp/t.jsonl");
  assert.match(env.PATH ?? "", /node_modules[\\/]\.bin/);
});

test("withLocalBinPath keeps a Windows Path value on a single PATH key", () => {
  const env = withLocalBinPath("C:\\app", {
    Path: "C:\\Program Files\\nodejs;C:\\Windows\\system32",
  });
  assert.equal(env.Path, undefined);
  assert.equal(env.path, undefined);
  assert.match(env.PATH ?? "", /node_modules[\\/]\.bin/);
  assert.match(env.PATH ?? "", /nodejs/);
});

test("nonzero test runner fails closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-run-fail-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "app", scripts: { test: "node --test src/index.test.js" } }),
  );
  writeFileSync(
    join(dir, "src", "index.test.js"),
    'const { test } = require("node:test"); test("fail", () => { throw new Error("boom"); });\n',
  );
  assert.throws(() => runTraces(dir, "tiny-trace-pkg", emptyEnv()), (e: unknown) => isExit(e, EXIT_FAIL));
});

test("trace spawn timeout fails closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-run-to-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "app", scripts: { test: "node --test src/hang.test.js" } }),
  );
  writeFileSync(
    join(dir, "src", "hang.test.js"),
    'const { test } = require("node:test"); test("hang", () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); });\n',
  );
  assert.throws(
    () => runTraces(dir, "tiny-trace-pkg", emptyEnv(), { timeoutMs: 200 }),
    (e: unknown) => isExit(e, EXIT_ENV),
  );
});

function writeTinyCjs(dir: string, testJs: string): void {
  mkdirSync(join(dir, "node_modules", "tiny-trace-pkg"), { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "node_modules", "tiny-trace-pkg", "package.json"),
    JSON.stringify({ name: "tiny-trace-pkg", main: "index.js" }),
  );
  writeFileSync(
    join(dir, "node_modules", "tiny-trace-pkg", "index.js"),
    "module.exports = { add(a, b) { return a + b; } };\n",
  );
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "app",
      type: "commonjs",
      scripts: { test: "node --test src/index.test.js" },
    }),
  );
  writeFileSync(join(dir, "src", "index.test.js"), testJs);
}

function assertSlim(err: unknown, code: number, re: RegExp): boolean {
  assert.equal(isExit(err, code), true);
  assert.match((err as Error).message, re);
  return true;
}

test("spawned runTraces missing session fails closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-run-nosess-"));
  writeTinyCjs(
    dir,
    `const { test } = require("node:test");
const assert = require("node:assert/strict");
const { add } = require("tiny-trace-pkg");
test("add", () => { assert.equal(add(2, 3), 5); });
process.on("exit", () => {
  require("node:fs").writeFileSync(process.env.SLIM_TRACE_OUT, JSON.stringify({ symbol: "add", args: [] }) + "\\n");
});
`,
  );
  assert.throws(
    () => runTraces(dir, "tiny-trace-pkg", emptyEnv()),
    (e: unknown) => assertSlim(e, EXIT_ENV, /trace hook did not load|missing session/),
  );
});

test("spawned runTraces serialize error fails closed while tests pass", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-run-ser-"));
  writeTinyCjs(
    dir,
    `const { test } = require("node:test");
const assert = require("node:assert/strict");
const { add } = require("tiny-trace-pkg");
test("add", () => {
  assert.equal(add(2, 3), 5);
  const boom = {};
  Object.defineProperty(boom, "x", { enumerable: true, get() { throw new Error("getter-boom"); } });
  add(boom, 0);
});
`,
  );
  assert.throws(
    () => runTraces(dir, "tiny-trace-pkg", emptyEnv()),
    (e: unknown) => assertSlim(e, EXIT_FAIL, /trace serialize/),
  );
});

test("spawned runTraces planted worker error fails closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-run-worker-"));
  writeTinyCjs(
    dir,
    `const { test } = require("node:test");
const assert = require("node:assert/strict");
const { add } = require("tiny-trace-pkg");
test("add", () => { assert.equal(add(2, 3), 5); });
process.on("exit", () => {
  require("node:fs").appendFileSync(
    process.env.SLIM_TRACE_OUT,
    JSON.stringify({ t: "error", kind: "worker", message: "boom" }) + "\\n",
  );
});
`,
  );
  assert.throws(
    () => runTraces(dir, "tiny-trace-pkg", emptyEnv()),
    (e: unknown) => assertSlim(e, EXIT_FAIL, /trace worker/),
  );
});

test("readTraceFile oversize bytes and event cap fail closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-run-over-"));
  const big = join(dir, "big.jsonl");
  const fd = openSync(big, "w");
  ftruncateSync(fd, MAX_TRACE_BYTES + 1);
  closeSync(fd);
  assert.throws(
    () => readTraceFile(big),
    (e: unknown) => assertSlim(e, EXIT_FAIL, /exceeds/),
  );
  const many = join(dir, "many.jsonl");
  const ev = JSON.stringify({ symbol: "add", args: [] }) + "\n";
  writeFileSync(many, sessionLine() + ev.repeat(MAX_TRACE_EVENTS + 1));
  assert.throws(
    () => readTraceFile(many),
    (e: unknown) => assertSlim(e, EXIT_FAIL, /exceeds/),
  );
});

test("spawned runTraces oversize JSONL fails closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-run-bytes-"));
  writeTinyCjs(
    dir,
    `const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { add } = require("tiny-trace-pkg");
test("add", () => { assert.equal(add(2, 3), 5); });
process.on("exit", () => {
  const fd = fs.openSync(process.env.SLIM_TRACE_OUT, "w");
  fs.ftruncateSync(fd, ${MAX_TRACE_BYTES + 1});
  fs.closeSync(fd);
});
`,
  );
  assert.throws(
    () => runTraces(dir, "tiny-trace-pkg", emptyEnv()),
    (e: unknown) => assertSlim(e, EXIT_FAIL, /exceeds/),
  );
});

test("siblingModule miss is the hook-missing failure", () => {
  const ghost = pathToFileURL(join(mkdtempSync(join(tmpdir(), "slim-run-ghost-")), "run.js")).href;
  assert.throws(() => siblingModule(ghost, "hook"), /missing/);
});

test("missing compiled hook fails runTraces closed", { timeout: 90_000 }, async () => {
  const dest = mkdtempSync(join(tmpdir(), "slim-run-nohook-"));
  withRepoDistLock(() => {
    if (!existsSync(join(ROOT, "dist", "trace", "match.js"))) {
      execPm("npm", ["run", "build"], { cwd: ROOT, encoding: "utf8", timeout: 240_000 });
    }
    cpSync(join(ROOT, "dist"), join(dest, "dist"), { recursive: true });
  });
  unlinkSync(join(dest, "dist", "trace", "hook.js"));
  const { runTraces: packedRun } = await import(
    pathToFileURL(join(dest, "dist", "trace", "run.js")).href
  ) as { runTraces: typeof runTraces };
  const app = mkdtempSync(join(tmpdir(), "slim-run-nohook-app-"));
  writeTinyCjs(
    app,
    `const { test } = require("node:test");
const assert = require("node:assert/strict");
const { add } = require("tiny-trace-pkg");
test("add", () => { assert.equal(add(2, 3), 5); });
`,
  );
  assert.throws(
    () => packedRun(app, "tiny-trace-pkg", emptyEnv()),
    (e: unknown) => {
      const err = e as { name?: string; code?: number; message: string };
      assert.equal(err.name, "SlimExit");
      assert.equal(err.code, EXIT_ENV);
      assert.match(err.message, /trace hook missing/);
      return true;
    },
  );
});
