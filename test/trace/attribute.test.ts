import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { attributeTraces } from "../../src/trace/attribute.ts";
import { mergeTraces } from "../../src/envelope/merge.ts";
import { closeEnvelope } from "../../src/envelope/close.ts";
import { ENVELOPE_VERSION, emptyHyrum } from "../../src/envelope/types.ts";
import type { CallSite, Envelope, TraceEvent, UnknownSite } from "../../src/envelope/types.ts";

function site(id: string, file: string, line: number, exportName: string, column = 1): CallSite {
  return {
    id,
    loc: { file, line, column, endLine: line, endColumn: column + 4 },
    exportName,
    memberPath: [],
    thisBinding: { kind: "unbound" },
    argc: { min: 2, max: 3, observed: [2] },
    argShapes: [],
    spread: false,
    resultMembers: [],
  };
}

function env(root: string, sites: CallSite[], unknowns: UnknownSite[] = []): Envelope {
  const byName = new Map<string, CallSite[]>();
  for (const s of sites) {
    const list = byName.get(s.exportName) ?? [];
    list.push(s);
    byName.set(s.exportName, list);
  }
  return {
    schemaVersion: ENVELOPE_VERSION,
    package: { name: "lodash", version: "4.17.21", family: "lodash", subpath: "" },
    env: ["node"],
    imports: [],
    symbols: [...byName.entries()].map(([exportName, callSites]) => ({
      exportName,
      packages: [],
      callSites,
      resultMembers: [],
      hyrum: emptyHyrum(),
      coverage: { callSitesStatic: callSites.length, callSitesTraced: 0 },
    })),
    unknowns,
    traces: [],
    closure: {
      confidence: "closed",
      readyToGenerate: true,
      staticCallSiteIds: sites.map((s) => s.id),
      tracedCallSiteIds: [],
      untracedCallSiteIds: sites.map((s) => s.id),
      reason: "",
    },
    slimmable: { score: 80, verdict: "slim", blockers: [], reasons: [] },
    clock: false,
    cryptoRandom: false,
  };
}

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "slim-attr-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), "export {}\n");
  writeFileSync(join(dir, "src", "b.ts"), "export {}\n");
  return dir;
}

test("one get trace does not mark sibling get call sites", () => {
  const root = tmpRoot();
  const a = site("call:src/a.ts:1", "src/a.ts", 1, "get");
  const b = site("call:src/b.ts:1", "src/b.ts", 2, "get");
  const base = env(root, [a, b]);
  const traces: TraceEvent[] = [
    {
      symbol: "get",
      originId: "o1",
      args: [],
      site: { file: join(root, "src", "a.ts"), line: 1, column: 1 },
    },
  ];
  const attributed = attributeTraces(base, traces, root);
  assert.equal(attributed[0]!.callSiteId, a.id);
  assert.equal(attributed[0]!.unmatched, false);
  const merged = mergeTraces(base, traces, { root });
  const get = merged.symbols.find((s) => s.exportName === "get")!;
  assert.equal(get.coverage.callSitesStatic, 2);
  assert.equal(get.coverage.callSitesTraced, 1);
  const closed = closeEnvelope(merged);
  assert.deepEqual(closed.closure.tracedCallSiteIds, [a.id]);
  assert.deepEqual(closed.closure.untracedCallSiteIds, [b.id]);
});

test("unmatched events block trace-closed and do not fill ids", () => {
  const root = tmpRoot();
  const a = site("call:src/a.ts:1", "src/a.ts", 1, "get");
  const base = env(root, [a]);
  const traces: TraceEvent[] = [
    {
      symbol: "get",
      originId: "x",
      args: [],
      site: { file: join(root, "src", "missing.ts"), line: 99, column: 1 },
    },
  ];
  const merged = mergeTraces(base, traces, { root });
  const closed = closeEnvelope(merged, { allowUnknown: true });
  assert.equal(closed.traces[0]!.unmatched, true);
  assert.deepEqual(closed.closure.tracedCallSiteIds, []);
  assert.notEqual(closed.closure.confidence, "trace-closed");
  assert.match(closed.closure.reason, /unmatched/);
});

test("debounce cancel inherits parent call site", () => {
  const root = tmpRoot();
  const d = site("call:src/a.ts:10", "src/a.ts", 10, "debounce");
  d.resultMembers = ["cancel", "flush"];
  const base = env(root, [d]);
  const traces: TraceEvent[] = [
    {
      symbol: "debounce",
      originId: "p",
      args: [],
      site: { file: join(root, "src", "a.ts"), line: 10, column: 1 },
    },
    {
      symbol: "debounce.cancel",
      originId: "c",
      parentOriginId: "p",
      resultMember: "cancel",
      args: [],
      site: { file: join(root, "src", "a.ts"), line: 20, column: 1 },
    },
  ];
  const attributed = attributeTraces(base, traces, root);
  assert.equal(attributed[0]!.callSiteId, d.id);
  assert.equal(attributed[1]!.callSiteId, d.id);
  assert.equal(attributed[1]!.unmatched, false);
});

test("default call of a function module attributes to the subpath export", () => {
  const root = tmpRoot();
  const g = site("call:src/a.ts:4", "src/a.ts", 4, "get");
  const base = env(root, [g]);
  const traces: TraceEvent[] = [
    {
      symbol: "default",
      originId: "g1",
      args: [],
      site: { file: join(root, "src", "a.ts"), line: 4, column: 10 },
    },
  ];
  const attributed = attributeTraces(base, traces, root);
  assert.equal(attributed[0]!.unmatched, false);
  assert.equal(attributed[0]!.callSiteId, g.id);
});

test("_.get attributes to the named get export", () => {
  const root = tmpRoot();
  const g = site("call:src/a.ts:4", "src/a.ts", 4, "get");
  const base = env(root, [g]);
  const traces: TraceEvent[] = [
    {
      symbol: "_.get",
      originId: "g1",
      args: [],
      site: { file: join(root, "src", "a.ts"), line: 4, column: 10 },
    },
  ];
  const attributed = attributeTraces(base, traces, root);
  assert.equal(attributed[0]!.unmatched, false);
  assert.equal(attributed[0]!.callSiteId, g.id);
});

test("default.resolve attributes to the named export and orphan children still match", () => {
  const root = tmpRoot();
  const r = site("call:src/a.ts:4", "src/a.ts", 4, "resolve");
  const base = env(root, [r]);
  const traces: TraceEvent[] = [
    {
      symbol: "default.resolve",
      originId: "child",
      parentOriginId: "missing-parent",
      args: [],
      site: { file: join(root, "src", "a.ts"), line: 4, column: 10 },
    },
  ];
  const attributed = attributeTraces(base, traces, root);
  assert.equal(attributed[0]!.unmatched, false);
  assert.equal(attributed[0]!.callSiteId, r.id);
});

test("dynamic-member observations attach only to the matching unknown", () => {
  const root = tmpRoot();
  const a = site("call:src/a.ts:1", "src/a.ts", 1, "get");
  const u1: UnknownSite = {
    id: "dyn:src/a.ts:5",
    loc: { file: "src/a.ts", line: 5, column: 1, endLine: 5, endColumn: 8 },
    kind: "dynamic-member",
    detail: "computed",
    widensTo: "all-exports",
    traceObservedMembers: null,
  };
  const u2: UnknownSite = {
    id: "dyn:src/b.ts:5",
    loc: { file: "src/b.ts", line: 5, column: 1, endLine: 5, endColumn: 8 },
    kind: "dynamic-member",
    detail: "other",
    widensTo: "all-exports",
    traceObservedMembers: null,
  };
  const base = env(root, [a], [u1, u2]);
  const traces: TraceEvent[] = [
    {
      symbol: "pick",
      originId: "o",
      args: [],
      site: { file: join(root, "src", "a.ts"), line: 5, column: 1 },
    },
  ];
  const merged = mergeTraces(base, traces, { root });
  assert.deepEqual(merged.unknowns[0]!.traceObservedMembers, ["pick"]);
  assert.equal(merged.unknowns[1]!.traceObservedMembers, null);
});

test("file URL and backslash trace paths attribute to posix envelope locs", () => {
  const root = tmpRoot();
  const a = site("call:src/a.ts:1", "src/a.ts", 1, "get");
  const base = env(root, [a]);
  const abs = join(root, "src", "a.ts");
  const traces: TraceEvent[] = [
    {
      symbol: "get",
      originId: "url",
      args: [],
      site: { file: pathToFileURL(abs).href, line: 1, column: 1 },
    },
  ];
  const attributed = attributeTraces(base, traces, root);
  assert.equal(attributed[0]!.unmatched, false);
  assert.equal(attributed[0]!.callSiteId, a.id);
});
