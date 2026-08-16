import { test } from "node:test";
import assert from "node:assert/strict";
import { availableParallelism } from "node:os";
import {
  ENVELOPE_VERSION,
  emptyHyrum,
  type Envelope,
  type SymbolEnvelope,
  type TraceEvent,
} from "../../src/envelope/types.ts";
import { EXIT_REFUSED, SlimExit } from "../../src/exit.ts";
import { runFuzz, defaultWorkerCount } from "../../src/fuzz/run.ts";
import { TAXONOMY } from "../../src/fuzz/debounce-driver.ts";

function toPath(path: unknown): string[] {
  if (Array.isArray(path)) return path.map((x) => `${x}`);
  return `${path}`.split(".").filter((s) => s.length > 0);
}

function getCorrect(object: unknown, path: unknown, defaultValue?: unknown): unknown {
  if (object == null) return defaultValue;
  let cur: unknown = object;
  for (const p of toPath(path)) {
    if (cur == null) return defaultValue;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur === undefined ? defaultValue : cur;
}

function getCorrectAlt(object: unknown, path: unknown, defaultValue?: unknown): unknown {
  if (object == null) return defaultValue;
  const segs = toPath(path);
  let i = 0;
  let acc: unknown = object;
  while (i < segs.length) {
    if (acc == null) return defaultValue;
    acc = (acc as Record<string, unknown>)[segs[i]!];
    i++;
  }
  return acc === undefined ? defaultValue : acc;
}

/** Known-bad: no dotted-path walk. */
function getBad(object: unknown, path: unknown, defaultValue?: unknown): unknown {
  if (object == null) return defaultValue;
  if (object !== null && typeof object === "object" && typeof path === "string") {
    const v = (object as Record<string, unknown>)[path];
    return v === undefined ? defaultValue : v;
  }
  return defaultValue;
}

function loc() {
  return { file: "t.ts", line: 1, column: 0, endLine: 1, endColumn: 10 };
}

function getSymbol(): SymbolEnvelope {
  return {
    exportName: "get",
    packages: [{ name: "lodash", version: "4.17.21", family: "lodash", subpath: "." }],
    callSites: [
      {
        id: "c1",
        loc: loc(),
        exportName: "get",
        memberPath: ["get"],
        thisBinding: { kind: "unbound" },
        argc: { min: 2, max: 3, observed: [2, 3] },
        argShapes: [
          {
            kind: "object",
            props: {
              a: {
                kind: "object",
                props: { b: { kind: "literal", literals: [1] } },
              },
            },
          },
          { kind: "literal", literals: ["a.b", "a", "missing"] },
          { kind: "literal", literals: [undefined, "fallback"] },
        ],
        spread: false,
        resultMembers: [],
      },
    ],
    resultMembers: [],
    hyrum: emptyHyrum(),
    coverage: { callSitesStatic: 1, callSitesTraced: 1 },
  };
}

function traces(): TraceEvent[] {
  const obj = {
    t: "obj" as const,
    keys: ["a"],
    v: {
      a: {
        t: "obj" as const,
        keys: ["b"],
        v: { b: { t: "num" as const, v: 1 } },
      },
    },
  };
  return [
    { symbol: "get", args: [obj, { t: "str", v: "a.b" }] },
    { symbol: "get", args: [obj, { t: "str", v: "a" }] },
    {
      symbol: "get",
      args: [obj, { t: "str", v: "z" }, { t: "str", v: "miss" }],
    },
  ];
}

function envelopeForGet(): Envelope {
  return {
    schemaVersion: ENVELOPE_VERSION,
    package: { name: "lodash", version: "4.17.21", family: "lodash", subpath: "." },
    env: ["node"],
    imports: [],
    symbols: [getSymbol()],
    unknowns: [],
    traces: traces(),
    closure: {
      confidence: "closed",
      readyToGenerate: true,
      untracedCallSiteIds: [],
      reason: "test",
    },
    slimmable: { score: 1, verdict: "slim", blockers: [], reasons: [] },
    clock: false,
    cryptoRandom: false,
  };
}

test("known-bad replacement of get disagrees", async () => {
  const report = await runFuzz({
    original: { get: getCorrect },
    replacement: { get: getBad },
    envelope: envelopeForGet(),
    budgetMs: 150,
    seed: 1,
    workers: 1,
  });
  assert.ok(report.cases > 0);
  assert.ok(report.comparisons > 0);
  assert.ok(report.disagreements.length > 0);
  assert.equal(report.disagreements[0]!.symbol, "get");
  assert.ok(report.disagreements[0]!.reason.length > 0);
});

test("two correct get implementations agree", async () => {
  const report = await runFuzz({
    original: { get: getCorrect },
    replacement: { get: getCorrectAlt },
    envelope: envelopeForGet(),
    budgetMs: 150,
    seed: 2,
    workers: 1,
  });
  assert.ok(report.cases > 0);
  assert.equal(report.disagreements.length, 0);
  assert.ok(report.tracesReplayed >= 3);
  assert.ok(report.wallMs >= 0);
  assert.equal(report.seed, 2);
});

test("default workers is availableParallelism()-1 (min 1)", () => {
  assert.equal(defaultWorkerCount(), Math.max(1, availableParallelism() - 1));
});

function trailingDebounce(
  fn: (...args: unknown[]) => unknown,
  wait: number,
): {
  (...args: unknown[]): unknown;
  cancel(): void;
  flush(): unknown;
} {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: unknown[] = [];
  let lastThis: unknown;
  let result: unknown;
  function invoke() {
    timer = null;
    result = fn.apply(lastThis, lastArgs);
    return result;
  }
  function debounced(this: unknown, ...args: unknown[]) {
    lastArgs = args;
    lastThis = this;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(invoke, wait);
    return result;
  }
  debounced.cancel = function cancel() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  debounced.flush = function flush() {
    if (timer !== null) {
      clearTimeout(timer);
      return invoke();
    }
    return result;
  };
  return debounced;
}

function envelopeForDebounce(argcObserved: number[]): Envelope {
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
            argc: {
              min: Math.min(...argcObserved),
              max: Math.max(...argcObserved),
              observed: argcObserved,
            },
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
      untracedCallSiteIds: [],
      reason: "test",
    },
    slimmable: { score: 1, verdict: "slim", blockers: [], reasons: [] },
    clock: true,
    cryptoRandom: false,
  };
}

test("CI taxonomy includes leading-only even for argc=2 envelopes", async () => {
  const prev = process.env.CI;
  const fuzzOpts = {
    original: { debounce: trailingDebounce },
    replacement: { debounce: trailingDebounce },
    envelope: envelopeForDebounce([2]),
    budgetMs: 50,
    seed: 3,
    workers: 1 as const,
  };
  try {
    delete process.env.CI;
    const user = await runFuzz(fuzzOpts);
    assert.equal(
      user.timerCases,
      10,
      "user envelope argc=2 should not run leading-only",
    );
    assert.equal(
      user.timerCases < Object.keys(TAXONOMY).length,
      true,
    );

    process.env.CI = "1";
    const ci = await runFuzz(fuzzOpts);
    assert.equal(ci.timerCases, 14);
    assert.ok(ci.timerCases >= 1);
  } finally {
    if (prev === undefined) delete process.env.CI;
    else process.env.CI = prev;
  }
});

test("fuzz passes hyrum.signedZero into equal", async () => {
  const env = envelopeForGet();
  env.symbols[0]!.exportName = "id";
  env.symbols[0]!.callSites[0]!.exportName = "id";
  env.symbols[0]!.hyrum = { ...emptyHyrum(), signedZero: true };
  env.traces = [{ symbol: "id", args: [] }];
  const disagree = await runFuzz({
    original: { id: () => -0 },
    replacement: { id: () => 0 },
    envelope: env,
    budgetMs: 20,
    seed: 4,
    workers: 1,
  });
  assert.ok(disagree.disagreements.length > 0, "hyrum.signedZero must distinguish -0");

  const agreeEnv = envelopeForGet();
  agreeEnv.symbols[0]!.exportName = "id";
  agreeEnv.symbols[0]!.callSites[0]!.exportName = "id";
  agreeEnv.traces = [{ symbol: "id", args: [] }];
  const agree = await runFuzz({
    original: { id: () => -0 },
    replacement: { id: () => 0 },
    envelope: agreeEnv,
    budgetMs: 20,
    seed: 4,
    workers: 1,
  });
  assert.equal(agree.disagreements.length, 0);
});

function envelopePkg(
  name: string,
  over: Partial<Envelope> = {},
): Envelope {
  return {
    schemaVersion: ENVELOPE_VERSION,
    package: { name, version: "1.0.0", family: name, subpath: "." },
    env: ["node"],
    imports: [],
    symbols: [
      {
        exportName: "id",
        packages: [{ name, version: "1.0.0", family: name, subpath: "." }],
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
      untracedCallSiteIds: [],
      reason: "test",
    },
    slimmable: { score: 1, verdict: "slim", blockers: [], reasons: [] },
    clock: false,
    cryptoRandom: false,
    ...over,
  };
}

async function assertRefused(fn: () => Promise<unknown>): Promise<SlimExit> {
  try {
    await fn();
  } catch (e) {
    assert.ok(e instanceof SlimExit, `expected SlimExit, got ${e}`);
    assert.equal(e.code, EXIT_REFUSED);
    return e;
  }
  assert.fail("expected SlimExit EXIT_REFUSED");
}

test("fuzz refuses unseeded RNG without --allow-flaky", async () => {
  const err = await assertRefused(() =>
    runFuzz({
      original: { id: () => 1 },
      replacement: { id: () => 1 },
      envelope: envelopePkg("chance", { cryptoRandom: true }),
      budgetMs: 10,
      seed: 1,
      workers: 1,
    }),
  );
  assert.match(err.message, /rng|random|flaky/i);
});

test("fuzz does not refuse uuid or nanoid cryptoRandom", async () => {
  for (const name of ["uuid", "nanoid"]) {
    const report = await runFuzz({
      original: { id: () => "x" },
      replacement: { id: () => "x" },
      envelope: envelopePkg(name, { cryptoRandom: true }),
      budgetMs: 10,
      seed: 1,
      workers: 1,
    });
    assert.equal(report.disagreements.length, 0, name);
  }
});

test("fuzz allows unseeded RNG with allowFlaky", async () => {
  const report = await runFuzz({
    original: { id: () => 1 },
    replacement: { id: () => 1 },
    envelope: envelopePkg("chance", { cryptoRandom: true }),
    budgetMs: 10,
    seed: 1,
    workers: 1,
    allowFlaky: true,
  });
  assert.ok(report.cases > 0);
});

test("fuzz refuses Date.now as a returned value when clock is false", async () => {
  const env = envelopePkg("lodash", { clock: false });
  env.symbols[0]!.exportName = "now";
  env.symbols[0]!.callSites[0]!.exportName = "now";
  env.traces = [{ symbol: "now", args: [] }];
  await assertRefused(() =>
    runFuzz({
      original: { now: () => 1 },
      replacement: { now: () => 1 },
      envelope: env,
      budgetMs: 10,
      seed: 1,
      workers: 1,
    }),
  );
});

test("fuzz refuses network/native packages and native/network blockers", async () => {
  await assertRefused(() =>
    runFuzz({
      original: { id: () => 1 },
      replacement: { id: () => 1 },
      envelope: envelopePkg("axios"),
      budgetMs: 10,
      seed: 1,
      workers: 1,
    }),
  );
  await assertRefused(() =>
    runFuzz({
      original: { id: () => 1 },
      replacement: { id: () => 1 },
      envelope: envelopePkg("weird-native", {
        slimmable: {
          score: 0,
          verdict: "refuse",
          blockers: ["native addon / .node"],
          reasons: ["native"],
        },
      }),
      budgetMs: 10,
      seed: 1,
      workers: 1,
    }),
  );
  await assertRefused(() =>
    runFuzz({
      original: { id: () => 1 },
      replacement: { id: () => 1 },
      envelope: envelopePkg("weird-http", {
        slimmable: {
          score: 0,
          verdict: "refuse",
          blockers: ["network client"],
          reasons: ["network"],
        },
      }),
      budgetMs: 10,
      seed: 1,
      workers: 1,
    }),
  );
});
