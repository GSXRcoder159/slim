import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeTraces, hyrumFromTraces } from "../src/envelope/merge.ts";
import { ENVELOPE_VERSION, emptyHyrum } from "../src/envelope/types.ts";
import type { Envelope, SymbolEnvelope, TraceEvent } from "../src/envelope/types.ts";

function envWith(symbol: string): Envelope {
  const sym: SymbolEnvelope = {
    exportName: symbol,
    packages: [],
    callSites: [],
    resultMembers: [],
    hyrum: emptyHyrum(),
    coverage: { callSitesStatic: 0, callSitesTraced: 0 },
  };
  if (symbol === "get") {
    sym.hyrum.prototype = true;
    sym.hyrum.sameReference = true;
  }
  return {
    schemaVersion: ENVELOPE_VERSION,
    package: { name: "lodash", version: "4.17.21", family: "lodash", subpath: "" },
    env: ["node"],
    imports: [],
    symbols: [sym],
    unknowns: [],
    traces: [],
    closure: {
      confidence: "closed",
      readyToGenerate: true,
      staticCallSiteIds: [],
      tracedCallSiteIds: [],
      untracedCallSiteIds: [],
      reason: "",
    },
    slimmable: { score: 80, verdict: "slim", blockers: [], reasons: [] },
    clock: false,
    cryptoRandom: false,
  };
}

test("hyrumFromTraces sets nan from tagged NaN", () => {
  const traces: TraceEvent[] = [
    { symbol: "get", args: [{ t: "num", v: "NaN" }], result: { t: "undef" } },
  ];
  assert.equal(hyrumFromTraces(traces).nan, true);
});

test("hyrumFromTraces sets signedZero from -0", () => {
  const traces: TraceEvent[] = [
    { symbol: "get", args: [{ t: "num", v: "-0" }], result: { t: "num", v: "-0" } },
  ];
  assert.equal(hyrumFromTraces(traces).signedZero, true);
});

test("hyrumFromTraces sets sparseArray from holes", () => {
  const traces: TraceEvent[] = [
    {
      symbol: "get",
      args: [{ t: "arr", v: [{ t: "num", v: 1 }], holes: [0] }],
      result: { t: "undef" },
    },
  ];
  assert.equal(hyrumFromTraces(traces).sparseArray, true);
});

test("hyrumFromTraces sets errorMessage from threw", () => {
  const traces: TraceEvent[] = [
    {
      symbol: "debounce",
      args: [{ t: "null" }],
      threw: { name: "TypeError", message: "Expected a function" },
    },
  ];
  assert.equal(hyrumFromTraces(traces).errorMessage, true);
});

test("hyrumFromTraces sets mutation from mutatedArgIndexes", () => {
  const traces: TraceEvent[] = [
    { symbol: "set", args: [], mutatedArgIndexes: [0] },
  ];
  assert.equal(hyrumFromTraces(traces).mutation, true);
});

test("hyrumFromTraces sets keyOrder from objects with 2+ keys", () => {
  const traces: TraceEvent[] = [
    {
      symbol: "assign",
      args: [
        {
          t: "obj",
          keys: ["a", "b"],
          v: { a: { t: "num", v: 1 }, b: { t: "num", v: 2 } },
        },
      ],
      result: { t: "undef" },
    },
  ];
  assert.equal(hyrumFromTraces(traces).keyOrder, true);
});

test("hyrumFromTraces sets sameReference and dateIdentity from result refs", () => {
  const obj: TraceEvent = {
    symbol: "get",
    args: [
      {
        t: "obj",
        keys: ["d"],
        v: { d: { t: "date", v: 1 } },
      },
    ],
    result: { t: "ref", id: 1 },
  };
  const h = hyrumFromTraces([obj]);
  assert.equal(h.sameReference, true);
  assert.equal(h.dateIdentity, true);
});

test("hyrumFromTraces sets prototype, toString, and json from result objects", () => {
  const traces: TraceEvent[] = [
    {
      symbol: "wrap",
      args: [],
      result: {
        t: "obj",
        keys: ["x"],
        v: { x: { t: "num", v: 1 } },
        proto: "null",
        toStr: true,
      },
    },
  ];
  const h = hyrumFromTraces(traces);
  assert.equal(h.prototype, true);
  assert.equal(h.toString, true);
  assert.equal(h.json, true);
});

test("mergeTraces ORs nan onto matching symbol without dropping proto heuristic", () => {
  const traces: TraceEvent[] = [
    { symbol: "get", args: [{ t: "num", v: "NaN" }], result: { t: "undef" } },
  ];
  const merged = mergeTraces(envWith("get"), traces);
  const get = merged.symbols.find((s) => s.exportName === "get")!;
  assert.equal(get.hyrum.nan, true);
  assert.equal(get.hyrum.prototype, true);
  assert.equal(get.hyrum.sameReference, true);
});
