import { test } from "node:test";
import assert from "node:assert/strict";
import { ENVELOPE_VERSION, emptyHyrum } from "../src/envelope/types.ts";
import type { Envelope } from "../src/envelope/types.ts";
import { buildPrompt } from "../src/generate/prompt.ts";
import type { PublicApiSpec } from "../src/generate/public-api.ts";

const LOC = { file: "src/a.ts", line: 1, column: 0, endLine: 1, endColumn: 10 };

function env(over: Partial<Envelope> = {}): Envelope {
  return {
    schemaVersion: ENVELOPE_VERSION,
    package: { name: "@scope/pkg", version: "1", family: "pkg", subpath: "" },
    env: ["node"],
    imports: [
      { loc: LOC, specifier: "@scope/pkg", kind: "default", names: [] },
      { loc: LOC, specifier: "@scope/pkg", kind: "namespace", names: [] },
    ],
    symbols: [
      {
        exportName: "get",
        packages: [],
        callSites: [
          {
            id: "a",
            loc: LOC,
            exportName: "get",
            memberPath: [],
            thisBinding: { kind: "unbound" },
            argc: { min: 2, max: 2, observed: [2] },
            argShapes: [{ kind: "object" }, { kind: "literal", literals: ["a"] }],
            spread: false,
            resultMembers: [],
          },
          {
            id: "b",
            loc: { ...LOC, line: 2 },
            exportName: "get",
            memberPath: ["get"],
            thisBinding: { kind: "unbound" },
            argc: { min: 3, max: 3, observed: [3] },
            argShapes: [
              { kind: "object" },
              { kind: "array", elements: [{ kind: "literal", literals: ["b"] }] },
              { kind: "literal", literals: [0] },
            ],
            spread: true,
            resultMembers: [],
          },
        ],
        resultMembers: [],
        hyrum: { ...emptyHyrum(), sameReference: true },
        coverage: { callSitesStatic: 2, callSitesTraced: 0 },
      },
    ],
    unknowns: [],
    traces: [],
    closure: {
      confidence: "closed",
      readyToGenerate: true,
      staticCallSiteIds: ["a", "b"],
      tracedCallSiteIds: [],
      untracedCallSiteIds: ["a", "b"],
      reason: "",
    },
    slimmable: { score: 80, verdict: "slim", blockers: [], reasons: [] },
    clock: false,
    cryptoRandom: false,
    ...over,
  };
}

test("envelope-only spec is named LIMITATION in the prompt", () => {
  const spec: PublicApiSpec = {
    text: "package @scope/pkg — no local .d.ts or README; implement from envelope call sites only.",
    source: "envelope-only",
    limitation:
      "package @scope/pkg — no local .d.ts or README; implement from envelope call sites only. Do not invent undocumented overloads.",
  };
  const { system, user } = buildPrompt(env(), spec, []);
  assert.match(user, /LIMITATION:/);
  assert.match(user, /Do not invent undocumented overloads/);
  assert.match(user, /Spec source: envelope-only/);
  assert.doesNotMatch(system, /debounce: TypeError/);
  assert.doesNotMatch(system, /get defaultValue only when/);
});

test("default and namespace imports require a default export in the system prompt", () => {
  const { system } = buildPrompt(env(), { text: "export function get(): unknown;", source: "bundled-dts" }, []);
  assert.match(system, /export default/);
});

test("prompt JSON includes every call site shape including the second", () => {
  const { user } = buildPrompt(env(), { text: "export function get(): unknown;", source: "bundled-dts" }, []);
  assert.match(user, /"spread": true/);
  assert.match(user, /"memberPath": \[\s*"get"\s*\]/);
  assert.match(user, /"kind": "default"/);
  assert.match(user, /"kind": "namespace"/);
  assert.match(user, /"sameReference": true/);
  assert.match(user, /"min": 2/);
  assert.match(user, /"min": 3/);
});

test("prompt never includes implementation trap text", () => {
  const spec: PublicApiSpec = {
    text: "export function trap(): void;",
    source: "bundled-dts",
    from: "node_modules/trap/index.d.ts",
  };
  const { user, system } = buildPrompt(env(), spec, []);
  assert.doesNotMatch(user, /FROM_IMPL/);
  assert.doesNotMatch(system, /FROM_IMPL/);
});
