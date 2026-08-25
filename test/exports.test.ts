import { test } from "node:test";
import assert from "node:assert/strict";
import * as ts from "typescript";
import { assembleCatalogModule } from "../src/generate/assemble.ts";
import { checkContracts } from "../src/generate/exports.ts";
import { ENVELOPE_VERSION, emptyHyrum } from "../src/envelope/types.ts";
import type { Envelope, ImportKind } from "../src/envelope/types.ts";

const LOC = { file: "x.ts", line: 1, column: 0, endLine: 1, endColumn: 10 };

function env(opts: {
  symbols: string[];
  importKind?: ImportKind;
  resultMembers?: Record<string, string[]>;
}): Envelope {
  const kind = opts.importKind ?? "named";
  return {
    schemaVersion: ENVELOPE_VERSION,
    package: { name: "lodash", version: "4.17.21", family: "lodash", subpath: "" },
    env: ["node"],
    imports: [{ loc: LOC, specifier: "lodash", kind, names: opts.symbols }],
    symbols: opts.symbols.map((exportName) => ({
      exportName,
      packages: [],
      callSites: [
        {
          id: `${exportName}:1`,
          loc: LOC,
          exportName,
          memberPath: [],
          thisBinding: { kind: "unbound" },
          argc: { min: 1, max: 1, observed: [1] },
          argShapes: [],
          spread: false,
          resultMembers: opts.resultMembers?.[exportName] ?? [],
        },
      ],
      resultMembers: opts.resultMembers?.[exportName] ?? [],
      hyrum: emptyHyrum(),
      coverage: { callSitesStatic: 1, callSitesTraced: 0 },
    })),
    unknowns: [],
    traces: [],
    closure: {
      confidence: "closed",
      readyToGenerate: true,
      staticCallSiteIds: [],
      tracedCallSiteIds: [],
      untracedCallSiteIds: [],
      reason: "test",
    },
    slimmable: { score: 80, verdict: "slim", blockers: [], reasons: [] },
    clock: opts.symbols.includes("debounce"),
    cryptoRandom: false,
  };
}

test("catalog get+debounce assemble satisfies contracts including result members", () => {
  const e = env({
    symbols: ["get", "debounce"],
    importKind: "default",
    resultMembers: { debounce: ["cancel", "flush"] },
  });
  const src = assembleCatalogModule(e);
  assert.ok(src);
  const r = checkContracts(ts, src!, e);
  assert.equal(r.ok, true, r.errors.join("; "));
});

test("missing named export fails", () => {
  const e = env({ symbols: ["get", "debounce"] });
  const src = `export function get(o: unknown) { return o; }\n`;
  const r = checkContracts(ts, src, e);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((x) => /debounce/.test(x)));
});

test("named-only module fails when envelope used default import", () => {
  const e = env({ symbols: ["get"], importKind: "default" });
  const src = `export function get(o: unknown) { return o; }\n`;
  const r = checkContracts(ts, src, e);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((x) => /default/.test(x)));
});

test("default object must include named exports for namespace imports", () => {
  const e = env({ symbols: ["get"], importKind: "namespace" });
  const src = `export function get(o: unknown) { return o; }\nexport default { other: get };\n`;
  const r = checkContracts(ts, src, e);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((x) => /default/.test(x) && /get/.test(x)));
});
