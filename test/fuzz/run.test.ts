import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ENVELOPE_VERSION,
  emptyHyrum,
  type Envelope,
  type SymbolEnvelope,
  type TraceEvent,
} from "../../src/envelope/types.ts";
import { runFuzz } from "../../src/fuzz/run.ts";

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
  });
  assert.ok(report.cases > 0);
  assert.equal(report.disagreements.length, 0);
  assert.ok(report.tracesReplayed >= 3);
  assert.ok(report.wallMs >= 0);
  assert.equal(report.seed, 2);
});
