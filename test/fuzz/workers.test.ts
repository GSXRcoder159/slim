import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import {
  ENVELOPE_VERSION,
  emptyHyrum,
  type Envelope,
} from "../../src/envelope/types.ts";
import { runFuzz } from "../../src/fuzz/run.ts";
import {
  toCloneableJob,
  fromCloneableJob,
  toCloneableResult,
  fromCloneableResult,
  runJob,
  workerThreadUrl,
  loadOrig,
} from "../../src/fuzz/workers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const catalogGet = join(root, "src", "generate", "catalog", "lodash.get.ts");
const catalogDebounce = join(root, "src", "generate", "catalog", "lodash.debounce.ts");
const require = createRequire(join(root, "package.json"));

let lodashSkip = "";
try {
  require("lodash");
} catch {
  lodashSkip = "lodash is not installed";
}

function loc() {
  return { file: "t.ts", line: 1, column: 0, endLine: 1, endColumn: 10 };
}

function envelopeGet(): Envelope {
  return {
    schemaVersion: ENVELOPE_VERSION,
    package: { name: "lodash", version: "4.17.21", family: "lodash", subpath: "." },
    env: ["node"],
    imports: [],
    symbols: [
      {
        exportName: "get",
        packages: [{ name: "lodash", version: "4.17.21", family: "lodash", subpath: "." }],
        callSites: [
          {
            id: "c1",
            loc: loc(),
            exportName: "get",
            memberPath: ["get"],
            thisBinding: { kind: "unbound" },
            argc: { min: 2, max: 3, observed: [2] },
            argShapes: [
              {
                kind: "object",
                props: { a: { kind: "literal", literals: [1] } },
              },
              { kind: "literal", literals: ["a"] },
            ],
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
    traces: [
      {
        symbol: "get",
        args: [
          {
            t: "obj",
            keys: ["a"],
            v: { a: { t: "num", v: 1 } },
          },
          { t: "str", v: "a" },
        ],
      },
    ],
    closure: {
      confidence: "closed",
      readyToGenerate: true,
      staticCallSiteIds: [],
      tracedCallSiteIds: [],
      untracedCallSiteIds: [],
      reason: "workers",
    },
    slimmable: { score: 1, verdict: "slim", blockers: [], reasons: [] },
    clock: false,
    cryptoRandom: false,
  };
}

function envelopeDebounce(): Envelope {
  return {
    schemaVersion: ENVELOPE_VERSION,
    package: { name: "lodash", version: "4.17.21", family: "lodash", subpath: "." },
    env: ["node"],
    imports: [],
    symbols: [
      {
        exportName: "debounce",
        packages: [{ name: "lodash", version: "4.17.21", family: "lodash", subpath: "." }],
        callSites: [
          {
            id: "d1",
            loc: loc(),
            exportName: "debounce",
            memberPath: ["debounce"],
            thisBinding: { kind: "unbound" },
            argc: { min: 2, max: 2, observed: [2] },
            argShapes: [
              { kind: "function", fnArity: 0 },
              { kind: "literal", literals: [32] },
            ],
            spread: false,
            resultMembers: ["cancel", "flush"],
          },
        ],
        resultMembers: ["cancel", "flush"],
        hyrum: emptyHyrum(),
        coverage: { callSitesStatic: 1, callSitesTraced: 0 },
      },
    ],
    unknowns: [],
    traces: [],
    closure: {
      confidence: "closed",
      readyToGenerate: true,
      staticCallSiteIds: [],
      tracedCallSiteIds: [],
      untracedCallSiteIds: [],
      reason: "workers",
    },
    slimmable: { score: 1, verdict: "slim", blockers: [], reasons: [] },
    clock: true,
    cryptoRandom: false,
  };
}

test(
  "workers>1 pool actually runs at least one case",
  { skip: lodashSkip || (!existsSync(catalogGet) ? "catalog lodash.get is not ready" : false) },
  async () => {
    const report = await runFuzz({
      origModule: "lodash",
      slimModule: catalogGet,
      slimHash: "workers-get-1",
      envelope: envelopeGet(),
      budgetMs: 80,
      seed: 11,
      workers: 2,
    });
    assert.ok(report.cases > 0, "pool must run at least one case");
    assert.equal(
      report.disagreements.length,
      0,
      report.disagreements.map((d) => d.reason).join("; "),
    );
  },
);

test(
  "lodash debounce agrees under fake clock in a worker when workers=2",
  {
    skip:
      lodashSkip ||
      (!existsSync(catalogDebounce) ? "catalog lodash.debounce is not ready" : false),
  },
  async () => {
    const report = await runFuzz({
      origModule: "lodash",
      slimModule: catalogDebounce,
      slimHash: "workers-debounce-1",
      envelope: envelopeDebounce(),
      budgetMs: 50,
      seed: 12,
      workers: 2,
    });
    assert.ok(report.cases > 0);
    assert.ok(report.timerCases > 0);
    assert.equal(
      report.disagreements.length,
      0,
      report.disagreements.map((d) => `${d.reason}`).join("; "),
    );
  },
);

function envelopeAlwaysDisagree(): Envelope {
  return {
    schemaVersion: ENVELOPE_VERSION,
    package: { name: "lodash", version: "4.17.21", family: "lodash", subpath: "." },
    env: ["node"],
    imports: [],
    symbols: [
      {
        exportName: "id",
        packages: [{ name: "lodash", version: "4.17.21", family: "lodash", subpath: "." }],
        callSites: [
          {
            id: "c1",
            loc: loc(),
            exportName: "id",
            memberPath: ["id"],
            thisBinding: { kind: "unbound" },
            argc: { min: 0, max: 0, observed: [0] },
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
    traces: [{ symbol: "id", args: [] }],
    closure: {
      confidence: "closed",
      readyToGenerate: true,
      staticCallSiteIds: [],
      tracedCallSiteIds: [],
      untracedCallSiteIds: [],
      reason: "cap",
    },
    slimmable: { score: 1, verdict: "slim", blockers: [], reasons: [] },
    clock: false,
    cryptoRandom: false,
  };
}

test("pool stops near MAX_DISAGREEMENTS and does not run unbounded cases", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-fuzz-cap-"));
  const orig = join(dir, "orig.mjs");
  const slim = join(dir, "slim.mjs");
  writeFileSync(orig, "export function id() { return 'orig'; }\n");
  writeFileSync(slim, "export function id() { return 'slim'; }\n");
  const report = await runFuzz({
    origModule: orig,
    slimModule: slim,
    slimHash: "cap-1",
    envelope: envelopeAlwaysDisagree(),
    budgetMs: 400,
    seed: 1,
    workers: 2,
  });
  assert.equal(report.disagreements.length, 20);
  assert.ok(
    report.cases <= 20,
    `pool kept scheduling after the cap: cases=${report.cases} disagreements=${report.disagreements.length}`,
  );
});

test("worker thread specifier matches current module extension", () => {
  const selfExt = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  const resolved = workerThreadUrl();
  assert.ok(
    resolved.href.endsWith(`worker-thread${selfExt}`),
    `expected worker-thread${selfExt}, got ${resolved.href}`,
  );
  assert.equal(existsSync(fileURLToPath(resolved)), true, `missing ${resolved.href}`);

  assert.throws(
    () => workerThreadUrl(pathToFileURL(join(tmpdir(), "no-such-fuzz", "workers.ts")).href),
    /runtime file missing/,
  );
});

test("cloneable roundtrip preserves function arity", () => {
  function two(a: unknown, b: unknown) {
    return [a, b];
  }
  assert.equal(two.length, 2);
  const wired = toCloneableJob({ symbol: "id", args: [two], kind: "call" });
  const fnWire = (wired.args[0] as { t?: string; length?: number }) ?? {};
  assert.equal(fnWire.t, "fn");
  assert.equal(fnWire.length, 2);
  const back = fromCloneableJob(wired);
  const revived = back.args[0] as Function;
  assert.equal(typeof revived, "function");
  assert.equal(revived.length, 2);
});

test("cloneable roundtrip preserves args[0] === thisArg alias", () => {
  const recv = { n: 1 };
  const wired = toCloneableJob({ symbol: "id", args: [recv], thisArg: recv, kind: "call" });
  const back = fromCloneableJob(wired);
  assert.equal(back.args[0], back.thisArg);
});

test("cloneable result roundtrip preserves cross-arg aliases", () => {
  const shared = { n: 1 };
  const wired = toCloneableResult({
    symbol: "id",
    ok: false,
    reason: "x",
    args: [shared, shared],
    minimized: [shared, shared],
  });
  const back = fromCloneableResult(wired);
  assert.equal(back.args?.[0], back.args?.[1]);
  assert.equal(back.minimized?.[0], back.minimized?.[1]);
});

test("runJob orig and slim observe args[0] === thisArg", async () => {
  const shared = { n: 1 };
  function bump(this: { n: number }, x: { n: number }) {
    if (this !== x) return -1;
    this.n += 1;
    return x.n;
  }
  const result = await runJob(
    { bump },
    { bump },
    {
      symbol: "bump",
      args: [shared],
      thisArg: shared,
      kind: "call",
      hyrum: { sameReference: true, mutation: true },
    },
  );
  assert.equal(result.ok, true, result.reason);
  assert.equal(shared.n, 1);
});

test("CJS function module exposes both default and its function name", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-loadorig-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "commonjs" }) + "\n");
  writeFileSync(join(dir, "get.js"), "module.exports = function get(o, p, d) { return o[p] ?? d; };\n");
  const orig = await loadOrig(join(dir, "get.js"), dir);
  assert.equal(typeof orig.default, "function");
  assert.equal(typeof orig.get, "function");
  assert.equal(orig.get, orig.default);
});
