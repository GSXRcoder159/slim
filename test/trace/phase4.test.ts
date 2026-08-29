import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { EXIT_FAIL, SlimExit } from "../../src/exit.ts";
import { extractEsmExportNames, matchesTracedUrl } from "../../src/trace/hook.ts";
import { runTraces, readTraceFile } from "../../src/trace/run.ts";
import { sessionLine } from "../../src/trace/session.ts";
import { wrapExports } from "../../src/trace/proxy.ts";
import { slimVitest, slimWrapperSource } from "../../src/trace/vitest.ts";
import { closeEnvelope } from "../../src/envelope/close.ts";
import { writeEvidence } from "../../src/evidence/report.ts";
import { plantReplacementTree } from "../helpers/documents.ts";
import { ENVELOPE_VERSION, emptyHyrum } from "../../src/envelope/types.ts";
import type { Envelope, TraceEvent } from "../../src/envelope/types.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const STAR = join(ROOT, "test/fixtures/trace/esm-star");
const NS = join(ROOT, "test/fixtures/trace/esm-ns");
const CHAIN = join(ROOT, "test/fixtures/trace/esm-chain");
const LIST = join(ROOT, "test/fixtures/trace/esm-list");
const DEF = join(ROOT, "test/fixtures/trace/esm-default");
const STAR_DEF = join(ROOT, "test/fixtures/trace/esm-star-default");
const NAMED = join(ROOT, "test/fixtures/trace/esm");
const HOOK = join(ROOT, "src/trace/hook.ts");

function emptyEnv(pkg: string, file = "src/index.test.js"): Envelope {
  return {
    schemaVersion: ENVELOPE_VERSION,
    package: { name: pkg, version: "1.0.0", family: pkg, subpath: "" },
    env: ["node"],
    imports: [],
    symbols: [
      {
        exportName: "add",
        packages: [],
        callSites: [
          {
            id: `call:${file}:1`,
            loc: { file, line: 4, column: 1, endLine: 4, endColumn: 20 },
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
      staticCallSiteIds: [`call:${file}:1`],
      tracedCallSiteIds: [],
      untracedCallSiteIds: [`call:${file}:1`],
      reason: "",
    },
    slimmable: { score: 80, verdict: "slim", blockers: [], reasons: [] },
    clock: false,
    cryptoRandom: false,
  };
}

function isFail(err: unknown): boolean {
  return err instanceof SlimExit && err.code === EXIT_FAIL;
}

function spawnHook(
  dir: string,
  pkg: string,
  extraExecArgv: string[] = [],
): { status: number; stdout: string; stderr: string; jsonl: string } {
  const outPath = join(dir, "traces.jsonl");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SLIM_TRACE_PACKAGES: pkg,
    SLIM_TRACE_OUT: outPath,
  };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_CHANNEL_FD;
  const r = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--import",
      pathToFileURL(HOOK).href,
      ...extraExecArgv,
      "--test",
      "src/index.test.js",
    ],
    { cwd: dir, encoding: "utf8", env },
  );
  let jsonl = "";
  try {
    jsonl = readFileSync(outPath, "utf8");
  } catch {
    /* missing */
  }
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "", jsonl };
}

test("extractEsmExportNames follows relative export *", () => {
  const parentUrl = pathToFileURL(join(STAR, "index.js")).href;
  const names = extractEsmExportNames(readFileSync(join(STAR, "index.js"), "utf8"), {
    parentUrl,
  });
  assert.deepEqual([...names].sort(), ["add", "get"]);
});

test("extractEsmExportNames records export * as ns", () => {
  const parentUrl = pathToFileURL(join(NS, "index.js")).href;
  const names = extractEsmExportNames(readFileSync(join(NS, "index.js"), "utf8"), {
    parentUrl,
  });
  assert.deepEqual(names, ["ns"]);
});

test("extractEsmExportNames follows a two-hop export * chain", () => {
  const parentUrl = pathToFileURL(join(CHAIN, "index.js")).href;
  const names = extractEsmExportNames(readFileSync(join(CHAIN, "index.js"), "utf8"), {
    parentUrl,
  });
  assert.deepEqual(names, ["add"]);
});

test("extractEsmExportNames skips type-only export type * and export type {}", () => {
  const names = extractEsmExportNames(
    `export type * from "./types.js";\nexport type { Foo } from "./types.js";\nexport function add() {}\n`,
    { parentUrl: "file:///tmp/pkg/index.js" },
  );
  assert.deepEqual(names, ["add"]);
});

test("extractEsmExportNames reports unresolved bare export *", () => {
  const unresolved: string[] = [];
  const names = extractEsmExportNames(`export * from "other-pkg";\nexport function local() {}\n`, {
    parentUrl: "file:///tmp/pkg/index.js",
    onUnresolvedStar: (spec) => unresolved.push(spec),
  });
  assert.ok(names.includes("local"));
  assert.deepEqual(unresolved, ["other-pkg"]);
});

test("extractEsmExportNames cycle in export * does not throw", () => {
  const files: Record<string, string> = {
    "file:///tmp/cyc/a.js": `export * from "./b.js";`,
    "file:///tmp/cyc/b.js": `export * from "./a.js";\nexport function add() {}`,
  };
  const names = extractEsmExportNames(files["file:///tmp/cyc/a.js"]!, {
    parentUrl: "file:///tmp/cyc/a.js",
    read: (url) => files[url] ?? null,
  });
  assert.deepEqual(names, ["add"]);
});

test("extractEsmExportNames records default from export default and export lists", () => {
  assert.ok(extractEsmExportNames(`export default function add() {}\n`).includes("default"));
  assert.ok(extractEsmExportNames(`export default class Foo {}\n`).includes("default"));
  assert.ok(extractEsmExportNames(`export { foo as default };\n`).includes("default"));
  assert.ok(extractEsmExportNames(`export { default } from "./impl.js";\n`).includes("default"));
  assert.equal(
    extractEsmExportNames(`export { default as v4 } from "./v4.js";\n`).includes("default"),
    false,
  );
  assert.deepEqual(
    extractEsmExportNames(`export { add, get } from "./impl.js";\n`).sort(),
    ["add", "get"],
  );
});

test("extractEsmExportNames export * does not copy default from the child", () => {
  const parentUrl = pathToFileURL(join(STAR_DEF, "index.js")).href;
  const names = extractEsmExportNames(readFileSync(join(STAR_DEF, "index.js"), "utf8"), {
    parentUrl,
  });
  assert.deepEqual([...names].sort(), ["add"]);
  assert.equal(names.includes("default"), false);
});

test("slimWrapperSource emits export default only when default is in the name list", () => {
  const named = slimWrapperSource("/pkg/index.js", "pkg", ["add"]);
  assert.match(named, /export const add = wrapped\["add"\]/);
  assert.doesNotMatch(named, /export default /);
  const withDef = slimWrapperSource("/pkg/index.js", "pkg", ["add", "default"]);
  assert.match(withDef, /export default wrapped\.default/);
});

test("vitest plugin.load default line is present iff the module has a default", () => {
  const namedDir = mkdtempSync(join(tmpdir(), "slim-p4-vite-named-"));
  const namedPkg = join(namedDir, "node_modules", "tiny-trace-esm");
  mkdirSync(namedPkg, { recursive: true });
  cpSync(NAMED, namedPkg, { recursive: true });
  const namedWrap = String(slimVitest({ packages: ["tiny-trace-esm"] }).load?.(join(namedPkg, "index.js")) ?? "");
  assert.match(namedWrap, /export const add = wrapped\["add"\]/);
  assert.doesNotMatch(namedWrap, /export default /);

  const defDir = mkdtempSync(join(tmpdir(), "slim-p4-vite-def-"));
  const defPkg = join(defDir, "node_modules", "tiny-trace-default");
  mkdirSync(defPkg, { recursive: true });
  cpSync(DEF, defPkg, { recursive: true });
  const defWrap = String(slimVitest({ packages: ["tiny-trace-default"] }).load?.(join(defPkg, "index.js")) ?? "");
  assert.match(defWrap, /export default wrapped\.default/);

  const cjsDir = mkdtempSync(join(tmpdir(), "slim-p4-vite-cjs-"));
  const cjsPkg = join(cjsDir, "node_modules", "tiny-trace-cjs");
  mkdirSync(cjsPkg, { recursive: true });
  cpSync(join(ROOT, "test/fixtures/trace/cjs"), cjsPkg, { recursive: true });
  const cjsWrap = String(slimVitest({ packages: ["tiny-trace-cjs"] }).load?.(join(cjsPkg, "index.js")) ?? "");
  assert.match(cjsWrap, /export default wrapped\.default/);
});

test("matchesTracedUrl does not treat nested node_modules as the parent package", () => {
  assert.equal(
    matchesTracedUrl("file:///app/node_modules/pkg/index.js", ["pkg"]),
    true,
  );
  assert.equal(
    matchesTracedUrl("file:///app/node_modules/pkg/node_modules/dep/index.js", ["pkg"]),
    false,
  );
  assert.equal(
    matchesTracedUrl("file:///app/node_modules/pkg.js", ["pkg"]),
    true,
  );
});

test("required trace with session header and zero package events fails closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-p4-zero-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "app", type: "module", scripts: { test: "node --test src/index.test.js" } }),
  );
  writeFileSync(
    join(dir, "src", "index.test.js"),
    `import { test } from "node:test";
import assert from "node:assert/strict";
test("no package", () => { assert.equal(1 + 1, 2); });
`,
  );
  assert.throws(
    () => runTraces(dir, "tiny-trace-star", emptyEnv("tiny-trace-star")),
    (e: unknown) => {
      assert.equal(isFail(e), true);
      assert.match((e as Error).message, /zero package events|not observed/);
      return true;
    },
  );
});

test("readTraceFile rejects non-event JSONL objects", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-p4-junk-"));
  const p = join(dir, "traces.jsonl");
  writeFileSync(p, sessionLine() + JSON.stringify({ hello: "world" }) + "\n");
  assert.throws(() => readTraceFile(p), (e: unknown) => isFail(e));
});

test("readTraceFile surfaces control error records", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-p4-err-"));
  const p = join(dir, "traces.jsonl");
  writeFileSync(
    p,
    sessionLine() + JSON.stringify({ t: "error", kind: "serialize", message: "boom" }) + "\n",
  );
  const parsed = readTraceFile(p);
  assert.equal(parsed.sawSession, true);
  assert.equal(parsed.events.length, 0);
  assert.equal(parsed.errors.length, 1);
  assert.equal(parsed.errors[0]!.kind, "serialize");
});

test("required trace fails closed on unmatched events", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-p4-unmatch-"));
  const pkgDir = join(dir, "node_modules", "tiny-trace-star");
  mkdirSync(pkgDir, { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  cpSync(STAR, pkgDir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "app",
      type: "module",
      scripts: { test: "node --test src/index.test.js" },
    }),
  );
  writeFileSync(
    join(dir, "src", "index.test.js"),
    `import { test } from "node:test";
import assert from "node:assert/strict";
import { add } from "tiny-trace-star";
test("add", () => { assert.equal(add(2, 3), 5); });
`,
  );
  const env = emptyEnv("tiny-trace-star", "src/never.ts");
  env.symbols[0]!.callSites[0]!.loc = {
    file: "src/never.ts",
    line: 99,
    column: 1,
    endLine: 99,
    endColumn: 10,
  };
  assert.throws(
    () => runTraces(dir, "tiny-trace-star", env),
    (e: unknown) => {
      assert.equal(isFail(e), true);
      assert.match((e as Error).message, /unmatched/);
      return true;
    },
  );
});

test("installed ESM export * named import records wrapped events", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-p4-star-"));
  const pkgDir = join(dir, "node_modules", "tiny-trace-star");
  mkdirSync(pkgDir, { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  cpSync(STAR, pkgDir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "app", type: "module" }));
  writeFileSync(
    join(dir, "src", "index.test.js"),
    `import { test } from "node:test";
import assert from "node:assert/strict";
import { add, get } from "tiny-trace-star";
test("star", () => {
  assert.equal(add(2, 3), 5);
  assert.equal(get({ a: 1 }, "a"), 1);
});
`,
  );
  const r = spawnHook(dir, "tiny-trace-star");
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.jsonl, /"t":"session"/);
  assert.match(r.jsonl, /"symbol":"add"/);
  assert.match(r.jsonl, /"symbol":"get"/);
  assert.doesNotMatch(r.jsonl, /export \* from orig/);
});

test("namespace re-export export * as ns stays import-compatible while tracing", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-p4-ns-"));
  const pkgDir = join(dir, "node_modules", "tiny-trace-ns");
  mkdirSync(pkgDir, { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  cpSync(NS, pkgDir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "app", type: "module" }));
  writeFileSync(
    join(dir, "src", "index.test.js"),
    `import { test } from "node:test";
import assert from "node:assert/strict";
import { ns } from "tiny-trace-ns";
test("ns", () => { assert.equal(ns.add(2, 3), 5); });
`,
  );
  const r = spawnHook(dir, "tiny-trace-ns");
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.jsonl, /"symbol":"add"/);
});

test("two-hop export * chain records the leaf export", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-p4-chain-"));
  const pkgDir = join(dir, "node_modules", "tiny-trace-chain");
  mkdirSync(pkgDir, { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  cpSync(CHAIN, pkgDir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "app", type: "module" }));
  writeFileSync(
    join(dir, "src", "index.test.js"),
    `import { test } from "node:test";
import assert from "node:assert/strict";
import { add } from "tiny-trace-chain";
test("chain", () => { assert.equal(add(2, 3), 5); });
`,
  );
  const r = spawnHook(dir, "tiny-trace-chain");
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.jsonl, /"symbol":"add"/);
});

test("named-only ESM is not default-importable while tracing", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-p4-named-"));
  const pkgDir = join(dir, "node_modules", "tiny-trace-esm");
  mkdirSync(pkgDir, { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  cpSync(NAMED, pkgDir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "app", type: "module" }));
  writeFileSync(
    join(dir, "src", "index.test.js"),
    `import { test } from "node:test";
import assert from "node:assert/strict";
import { add } from "tiny-trace-esm";
import * as ns from "tiny-trace-esm";
test("named", async () => {
  assert.equal(add(2, 3), 5);
  assert.equal("default" in ns, false);
  await assert.rejects(() => import("./default-import.js"));
});
`,
  );
  writeFileSync(join(dir, "src", "default-import.js"), `import add from "tiny-trace-esm";\nvoid add;\n`);
  const r = spawnHook(dir, "tiny-trace-esm");
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.jsonl, /"symbol":"add"/);
});

test("default-only ESM stays default-importable and records the public name", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-p4-def-"));
  const pkgDir = join(dir, "node_modules", "tiny-trace-default");
  mkdirSync(pkgDir, { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  cpSync(DEF, pkgDir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "app", type: "module" }));
  writeFileSync(
    join(dir, "src", "index.test.js"),
    `import { test } from "node:test";
import assert from "node:assert/strict";
import add from "tiny-trace-default";
test("default", () => { assert.equal(add(2, 3), 5); });
`,
  );
  const r = spawnHook(dir, "tiny-trace-default");
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.jsonl, /"symbol":"default"/);
});

test("export list from impl records add and get", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-p4-list-"));
  const pkgDir = join(dir, "node_modules", "tiny-trace-list");
  mkdirSync(pkgDir, { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  cpSync(LIST, pkgDir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "app", type: "module" }));
  writeFileSync(
    join(dir, "src", "index.test.js"),
    `import { test } from "node:test";
import assert from "node:assert/strict";
import { add, get } from "tiny-trace-list";
test("list", () => {
  assert.equal(add(2, 3), 5);
  assert.equal(get({ a: 1 }, "a"), 1);
});
`,
  );
  const r = spawnHook(dir, "tiny-trace-list");
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.jsonl, /"symbol":"add"/);
  assert.match(r.jsonl, /"symbol":"get"/);
});

test("export * from a child with default is not default-importable", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-p4-stardef-"));
  const pkgDir = join(dir, "node_modules", "tiny-trace-star-default");
  mkdirSync(pkgDir, { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  cpSync(STAR_DEF, pkgDir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "app", type: "module" }));
  writeFileSync(
    join(dir, "src", "index.test.js"),
    `import { test } from "node:test";
import assert from "node:assert/strict";
import { add } from "tiny-trace-star-default";
import * as ns from "tiny-trace-star-default";
test("star default", async () => {
  assert.equal(add(2, 3), 5);
  assert.equal("default" in ns, false);
  await assert.rejects(() => import("./default-import.js"));
});
`,
  );
  writeFileSync(
    join(dir, "src", "default-import.js"),
    `import add from "tiny-trace-star-default";\nvoid add;\n`,
  );
  const r = spawnHook(dir, "tiny-trace-star-default");
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.jsonl, /"symbol":"add"/);
  assert.doesNotMatch(r.jsonl, /"symbol":"default"/);
});

test("worker without caller execArgv still records package calls", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-p4-worker-"));
  const pkgDir = join(dir, "node_modules", "tiny-trace-worker");
  mkdirSync(pkgDir, { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  cpSync(join(ROOT, "test/fixtures/trace/worker"), pkgDir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "app", type: "commonjs" }));
  writeFileSync(
    join(dir, "src", "worker.cjs"),
    `const { parentPort } = require("node:worker_threads");
const { add } = require("tiny-trace-worker");
parentPort.postMessage(add(2, 3));
`,
  );
  writeFileSync(
    join(dir, "src", "index.test.js"),
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
  const r = spawnHook(dir, "tiny-trace-worker");
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.jsonl, /"symbol":"add"/);
});

test("serialize throw still returns the user result and emits a serialize error record", () => {
  const events: TraceEvent[] = [];
  const errors: Array<{ t?: string; kind?: string }> = [];
  const boom = {
    get x() {
      throw new Error("getter-boom");
    },
  };
  const mod = {
    id(_v: unknown) {
      return 7;
    },
  };
  const wrapped = wrapExports(mod, {
    packageName: "x",
    onEvent: (e) => events.push(e),
    onError: (e) => errors.push(e),
  }) as typeof mod;
  assert.equal(wrapped.id(boom), 7);
  assert.equal(errors.some((e) => e.kind === "serialize"), true);
});

test("in-package calls between wrapped files are not recorded as user events", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-p4-internal-"));
  const pkgDir = join(dir, "node_modules", "tiny-trace-internal");
  mkdirSync(join(pkgDir), { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "tiny-trace-internal", type: "module", exports: "./index.js" }),
  );
  writeFileSync(join(pkgDir, "inner.js"), `export function inner() { return 1; }\n`);
  writeFileSync(
    join(pkgDir, "index.js"),
    `import { inner } from "./inner.js";
export { inner };
export function outer() { return inner(); }
`,
  );
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "app", type: "module" }));
  writeFileSync(
    join(dir, "src", "index.test.js"),
    `import { test } from "node:test";
import assert from "node:assert/strict";
import { outer } from "tiny-trace-internal";
test("outer", () => { assert.equal(outer(), 1); });
`,
  );
  const r = spawnHook(dir, "tiny-trace-internal");
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.jsonl, /"symbol":"outer"/);
  assert.doesNotMatch(r.jsonl, /"symbol":"inner"/);
});

test("named re-export of a default export records the public name", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-p4-default-as-"));
  const pkgDir = join(dir, "node_modules", "tiny-trace-v4");
  mkdirSync(pkgDir, { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "tiny-trace-v4", type: "module", exports: "./index.js" }),
  );
  writeFileSync(join(pkgDir, "v4.js"), `export default function v4() { return "id"; }\n`);
  writeFileSync(join(pkgDir, "index.js"), `export { default as v4 } from "./v4.js";\n`);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "app", type: "module" }));
  writeFileSync(
    join(dir, "src", "index.test.js"),
    `import { test } from "node:test";
import assert from "node:assert/strict";
import { v4 } from "tiny-trace-v4";
test("v4", () => { assert.equal(v4(), "id"); });
`,
  );
  const r = spawnHook(dir, "tiny-trace-v4");
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.jsonl, /"symbol":"v4"/);
  assert.doesNotMatch(r.jsonl, /"symbol":"default"/);
});

test("thenable function results stay wrapped", async () => {
  const events: TraceEvent[] = [];
  const mod = {
    async factory() {
      return function inner() {
        return 42;
      };
    },
  };
  const wrapped = wrapExports(mod, {
    packageName: "x",
    onEvent: (e) => events.push(e),
  }) as typeof mod;
  const inner = await wrapped.factory();
  assert.equal(inner(), 42);
  assert.equal(events.some((e) => e.symbol === "factory"), true);
  assert.equal(events.some((e) => e.symbol === "factory()"), true);
});

test("non-Promise thenables that resolve to functions stay wrapped", async () => {
  const events: TraceEvent[] = [];
  const mod = {
    factory() {
      return {
        then(resolve: (v: unknown) => void) {
          resolve(function inner() {
            return 9;
          });
        },
      };
    },
  };
  const wrapped = wrapExports(mod, {
    packageName: "x",
    onEvent: (e) => events.push(e),
  }) as { factory: () => Promise<(() => number)> };
  const inner = await wrapped.factory();
  assert.equal(inner(), 9);
  assert.equal(events.some((e) => e.symbol === "factory()"), true);
});

test("unresolved star through runTraces fails closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-p4-unstar-"));
  const pkgDir = join(dir, "node_modules", "tiny-trace-unstar");
  mkdirSync(pkgDir, { recursive: true });
  mkdirSync(join(dir, "node_modules", "other-pkg"), { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "tiny-trace-unstar", type: "module", exports: "./index.js" }),
  );
  writeFileSync(
    join(pkgDir, "index.js"),
    `export * from "other-pkg";\nexport function add(a, b) { return a + b; }\n`,
  );
  writeFileSync(
    join(dir, "node_modules", "other-pkg", "package.json"),
    JSON.stringify({ name: "other-pkg", type: "module", exports: "./index.js" }),
  );
  writeFileSync(join(dir, "node_modules", "other-pkg", "index.js"), `export function hidden() { return 1; }\n`);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "app",
      type: "module",
      scripts: { test: "node --test src/index.test.js" },
    }),
  );
  writeFileSync(
    join(dir, "src", "index.test.js"),
    `import { test } from "node:test";
import assert from "node:assert/strict";
import { add } from "tiny-trace-unstar";
test("add", () => { assert.equal(add(2, 3), 5); });
`,
  );
  const env = emptyEnv("tiny-trace-unstar");
  assert.throws(
    () => runTraces(dir, "tiny-trace-unstar", env),
    (e: unknown) => {
      assert.equal(isFail(e), true);
      assert.match((e as Error).message, /unresolved-star/);
      return true;
    },
  );
});

test("patchWorkers failure emits a worker error record", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-p4-pworker-"));
  const outPath = join(dir, "traces.jsonl");
  const script = join(dir, "freeze.mjs");
  writeFileSync(
    script,
    `import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
const wt = req("node:worker_threads");
Object.defineProperty(wt, "Worker", { value: wt.Worker, configurable: false, writable: false });
await import(${JSON.stringify(pathToFileURL(HOOK).href)});
`,
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SLIM_TRACE_PACKAGES: "tiny-trace-worker",
    SLIM_TRACE_OUT: outPath,
  };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_CHANNEL_FD;
  const r = spawnSync(process.execPath, ["--experimental-strip-types", script], {
    cwd: dir,
    encoding: "utf8",
    env,
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const jsonl = readFileSync(outPath, "utf8");
  assert.match(jsonl, /"kind":"worker"/);
});

test("closeEnvelope staticOnly names --no-trace and cannot be trace-closed", () => {
  const closed = closeEnvelope(emptyEnv("pkg"), { staticOnly: true });
  assert.notEqual(closed.closure.confidence, "trace-closed");
  assert.match(closed.closure.reason, /--no-trace/);
  const root = mkdtempSync(join(tmpdir(), "slim-p4-ev-"));
  plantReplacementTree(root, { pkg: "pkg", moduleRel: "src/slim/pkg.ts" });
  const { mdPath, jsonPath } = writeEvidence({
    root,
    env: closed,
    replacementBytes: 10,
    originalMin: 100,
    fuzz: {
      cases: 0,
      comparisons: 0,
      timerCases: 0,
      tracesReplayed: 0,
      wallMs: 0,
      seed: 1,
      disagreements: 0,
    },
    catalogIds: [],
    coverageHoles: ["zero traces replayed"],
    bundle: null,
    revert: {
      package: "pkg",
      version: "1.0.0",
      module: "src/slim/pkg.ts",
      tests: "src/slim/pkg.test.ts",
      cjsCompanion: null,
      rewrites: [],
      lockfile: "npm",
      installCommand: "npm install",
    },
  });
  const md = readFileSync(mdPath, "utf8");
  const json = JSON.parse(readFileSync(jsonPath, "utf8")) as { residualRisk: string[] };
  assert.match(md, /--no-trace/);
  assert.match(md, /cannot claim trace closure/);
  assert.doesNotMatch(md, /trace-closed/);
  assert.equal(json.residualRisk.some((s) => s.includes("--no-trace")), true);
});
