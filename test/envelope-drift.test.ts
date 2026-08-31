import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { diffEnvelope } from "../src/envelope/drift.ts";
import {
  ENVELOPE_VERSION,
  emptyHyrum,
  hashEnvelope,
  type CallSite,
  type Envelope,
  type ImportSite,
} from "../src/envelope/types.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const LOC = { file: "src/a.ts", line: 1, column: 0, endLine: 1, endColumn: 8 };

function site(over: Partial<CallSite> & { exportName: string }): CallSite {
  return {
    id: over.id ?? "s1",
    loc: over.loc ?? LOC,
    exportName: over.exportName,
    memberPath: over.memberPath ?? [],
    thisBinding: over.thisBinding ?? { kind: "unbound" },
    argc: over.argc ?? { min: 2, max: 2, observed: [2] },
    argShapes: over.argShapes ?? [
      { kind: "object" },
      { kind: "literal", literals: ["a"] },
    ],
    spread: over.spread ?? false,
    resultMembers: over.resultMembers ?? [],
  };
}

function envelope(over: Partial<Envelope> & { symbols: Envelope["symbols"] }): Envelope {
  return {
    schemaVersion: ENVELOPE_VERSION,
    package: over.package ?? { name: "lodash", version: "4.17.21", family: "lodash", subpath: "" },
    env: over.env ?? ["node"],
    imports: over.imports ?? [
      { loc: LOC, specifier: "lodash", kind: "named", names: ["get"] },
    ],
    symbols: over.symbols,
    unknowns: over.unknowns ?? [],
    traces: [],
    closure: over.closure ?? {
      confidence: "closed",
      readyToGenerate: true,
      staticCallSiteIds: [],
      tracedCallSiteIds: [],
      untracedCallSiteIds: [],
      reason: "test",
    },
    slimmable: { score: 80, verdict: "slim", blockers: [], reasons: [] },
    clock: false,
    cryptoRandom: false,
  };
}

function getSym(callSites: CallSite[], resultMembers: string[] = []) {
  return {
    exportName: "get",
    packages: [],
    callSites,
    resultMembers,
    hyrum: emptyHyrum(),
    coverage: { callSitesStatic: callSites.length, callSitesTraced: 0 },
  };
}

test("unchanged envelopes have no drift", () => {
  const saved = envelope({ symbols: [getSym([site({ exportName: "get" })])] });
  assert.deepEqual(diffEnvelope(saved, saved), []);
});

test("unchanged golden fixture envelope hashes match evidence and manifest", () => {
  const env = JSON.parse(
    readFileSync(join(ROOT, "fixtures/lodash-get-debounce/.slim/lodash/envelope.json"), "utf8"),
  ) as Envelope;
  assert.deepEqual(diffEnvelope(env, env), []);
  const hash = hashEnvelope(env);
  const evidence = JSON.parse(
    readFileSync(join(ROOT, "fixtures/lodash-get-debounce/.slim/lodash/evidence.json"), "utf8"),
  ) as { envelopeHash: string };
  const man = JSON.parse(readFileSync(join(ROOT, "fixtures/lodash-get-debounce/.slim/manifest.json"), "utf8")) as {
    replacements: { lodash: { envelopeHash: string } };
  };
  assert.equal(evidence.envelopeHash, hash);
  assert.equal(man.replacements.lodash.envelopeHash, hash);
});

test("new call shape on existing get is drift", () => {
  const saved = envelope({ symbols: [getSym([site({ exportName: "get" })])] });
  const live = envelope({
    symbols: [
      getSym([
        site({ exportName: "get" }),
        site({
          id: "s2",
          exportName: "get",
          argc: { min: 3, max: 3, observed: [3] },
          argShapes: [{ kind: "object" }, { kind: "literal", literals: ["a"] }, { kind: "literal", literals: [1] }],
        }),
      ]),
    ],
  });
  const drift = diffEnvelope(saved, live);
  assert.ok(drift.some((d) => d.kind === "shape" && /get/.test(d.detail)), JSON.stringify(drift));
});

test("a second identical call site is not hidden by semantic fingerprint dedupe", () => {
  const saved = envelope({ symbols: [getSym([site({ exportName: "get" })])] });
  const live = envelope({ symbols: [getSym([site({ exportName: "get" }), site({ id: "s2", exportName: "get" })])] });
  assert.ok(diffEnvelope(saved, live).some((d) => d.kind === "shape"), "duplicate call site must drift");
});

test("new observed argc is drift", () => {
  const saved = envelope({
    symbols: [getSym([site({ exportName: "get", argc: { min: 2, max: 2, observed: [2] } })])],
  });
  const live = envelope({
    symbols: [getSym([site({ exportName: "get", argc: { min: 2, max: 3, observed: [2, 3] } })])],
  });
  assert.ok(diffEnvelope(saved, live).some((d) => d.kind === "shape"));
});

test("new options object shape is drift", () => {
  const saved = envelope({
    symbols: [
      getSym([
        site({
          exportName: "debounce",
          argc: { min: 2, max: 2, observed: [2] },
          argShapes: [{ kind: "function" }, { kind: "literal", literals: [32] }],
        }),
      ]),
    ],
  });
  saved.symbols[0]!.exportName = "debounce";
  saved.symbols[0]!.callSites[0]!.exportName = "debounce";
  const live = envelope({
    symbols: [
      getSym([
        site({
          exportName: "debounce",
          argc: { min: 3, max: 3, observed: [3] },
          argShapes: [
            { kind: "function" },
            { kind: "literal", literals: [32] },
            { kind: "object", props: { leading: { kind: "literal", literals: [true] } } },
          ],
        }),
      ]),
    ],
  });
  live.symbols[0]!.exportName = "debounce";
  live.symbols[0]!.callSites[0]!.exportName = "debounce";
  assert.ok(diffEnvelope(saved, live).some((d) => d.kind === "shape"));
});

test("new result member is drift", () => {
  const saved = envelope({ symbols: [getSym([site({ exportName: "debounce", resultMembers: ["cancel"] })])] });
  saved.symbols[0]!.exportName = "debounce";
  const live = envelope({
    symbols: [getSym([site({ exportName: "debounce", resultMembers: ["cancel", "flush"] })], ["cancel", "flush"])],
  });
  live.symbols[0]!.exportName = "debounce";
  assert.ok(diffEnvelope(saved, live).some((d) => d.kind === "resultMember" && /flush/.test(d.detail)));
});

test("new import form is drift", () => {
  const named: ImportSite = { loc: LOC, specifier: "lodash", kind: "named", names: ["get"] };
  const cjs: ImportSite = { loc: LOC, specifier: "lodash", kind: "cjs-require", names: ["get"] };
  const saved = envelope({ symbols: [getSym([site({ exportName: "get" })])], imports: [named] });
  const live = envelope({ symbols: [getSym([site({ exportName: "get" })])], imports: [named, cjs] });
  assert.ok(diffEnvelope(saved, live).some((d) => d.kind === "import" && /cjs-require/.test(d.detail)));
});

test("new env tag is drift", () => {
  const saved = envelope({ symbols: [getSym([site({ exportName: "get" })])], env: ["node"] });
  const live = envelope({ symbols: [getSym([site({ exportName: "get" })])], env: ["node", "worker"] });
  assert.ok(diffEnvelope(saved, live).some((d) => d.kind === "env" && /worker/.test(d.detail)));
});

test("new unknown is drift", () => {
  const saved = envelope({ symbols: [getSym([site({ exportName: "get" })])] });
  const live = envelope({
    symbols: [getSym([site({ exportName: "get" })])],
    unknowns: [
      {
        id: "u1",
        loc: LOC,
        kind: "dynamic-member",
        detail: "obj[x]",
        widensTo: "all-exports",
        traceObservedMembers: null,
      },
    ],
  });
  assert.ok(diffEnvelope(saved, live).some((d) => d.kind === "unknown"));
});

test("added symbol is drift", () => {
  const saved = envelope({ symbols: [getSym([site({ exportName: "get" })])] });
  const live = envelope({
    symbols: [
      getSym([site({ exportName: "get" })]),
      {
        exportName: "map",
        packages: [],
        callSites: [site({ exportName: "map" })],
        resultMembers: [],
        hyrum: emptyHyrum(),
        coverage: { callSitesStatic: 1, callSitesTraced: 0 },
      },
    ],
  });
  assert.ok(diffEnvelope(saved, live).some((d) => d.kind === "symbol" && /map/.test(d.detail)));
});
