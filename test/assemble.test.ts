import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { assembleCatalogModule } from "../src/generate/assemble.ts";
import { validateGenerated } from "../src/generate/validate.ts";
import { ENVELOPE_VERSION, emptyHyrum } from "../src/envelope/types.ts";
import type { Envelope, ImportKind } from "../src/envelope/types.ts";

const LOC = { file: "x.ts", line: 1, column: 0, endLine: 1, endColumn: 10 };

function env(symbols: string[], imports: { kind: ImportKind; names?: string[] }[] = []): Envelope {
  return {
    schemaVersion: ENVELOPE_VERSION,
    package: { name: "lodash", version: "4.17.21", family: "lodash", subpath: "" },
    env: ["node"],
    imports: imports.map((i) => ({
      loc: LOC,
      specifier: "lodash",
      kind: i.kind,
      names: i.names ?? ["_"],
    })),
    symbols: symbols.map((exportName) => ({
      exportName,
      packages: [],
      callSites: [],
      resultMembers: [],
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
    clock: symbols.includes("debounce") || symbols.includes("throttle"),
    cryptoRandom: false,
  };
}

test("assembled uuid and nanoid look up crypto at call time, not module scope", () => {
  const uuidEnv: Envelope = {
    ...env(["v4"]),
    package: { name: "uuid", version: "11.1.0", family: "uuid", subpath: "" },
    cryptoRandom: true,
  };
  const uuidSrc = assembleCatalogModule(uuidEnv);
  assert.ok(uuidSrc);
  assert.match(uuidSrc!, /globalThis\.crypto/);
  assert.doesNotMatch(uuidSrc!, /const crypto = globalThis\.crypto/);
  assert.doesNotMatch(uuidSrc!, /from ["']uuid["']/);
  const uuidVal = validateGenerated(ts, uuidSrc!, { envelope: uuidEnv });
  assert.equal(uuidVal.ok, true, uuidVal.errors.join("; "));

  const nanoEnv: Envelope = {
    ...env(["nanoid", "customAlphabet"]),
    package: { name: "nanoid", version: "5.1.5", family: "nanoid", subpath: "" },
    cryptoRandom: true,
  };
  const nanoSrc = assembleCatalogModule(nanoEnv);
  assert.ok(nanoSrc);
  assert.match(nanoSrc!, /globalThis\.crypto/);
  assert.match(nanoSrc!, /export function nanoid/);
  assert.match(nanoSrc!, /export function customAlphabet/);
  assert.doesNotMatch(nanoSrc!, /from ["']nanoid["']/);
  assert.doesNotMatch(nanoSrc!, /export function get\b/);
  const nanoVal = validateGenerated(ts, nanoSrc!, { envelope: nanoEnv });
  assert.equal(nanoVal.ok, true, nanoVal.errors.join("; "));
});

test("assemble get+debounce is standalone and names the exports", () => {
  const src = assembleCatalogModule(env(["get", "debounce"]));
  assert.ok(src);
  assert.match(src!, /export function get/);
  assert.match(src!, /export function debounce/);
  assert.match(src!, /EVIDENCE, NOT PROOF|evidence, not proof/i);
  assert.doesNotMatch(src!, /from ["']lodash/);
});

test("assemble head and first share one binding and do not pull the lodash bundle", () => {
  for (const symbols of [["head"], ["first"], ["head", "first"]]) {
    const e = env(symbols, [{ kind: "default", names: ["_"] }]);
    const src = assembleCatalogModule(e);
    assert.ok(src, String(symbols));
    const firstBindings = src!.match(/\bexport\s+(?:const|function)\s+first\b/g) ?? [];
    assert.equal(firstBindings.length, 1, `${symbols.join(",")}: duplicate first`);
    assert.match(src!, /export function head/);
    assert.doesNotMatch(src!, /export function get\b/);
    const val = validateGenerated(ts, src!, { envelope: e });
    assert.equal(val.ok, true, `${symbols.join(",")}: ${val.errors.join("; ")}`);
  }
});

test("assembled header uses SPDX MIT and exact provenance lines", () => {
  const src = assembleCatalogModule(env(["get", "debounce"]));
  assert.ok(src);
  assert.ok(src!.startsWith("/**"), "header must be the first lines");
  assert.match(src!, /^\s*\/\*\*\n \* SPDX-License-Identifier: MIT\n/m);
  assert.match(src!, /Slim generated implementation\. n-gram similarity is a CI heuristic, not a legal opinion\./);
  assert.match(src!, /Envelope [0-9a-f]{64}/);
  assert.match(src!, /Catalog lodash\.get, lodash\.debounce/);
  assert.match(src!, /Evidence: \.slim\/lodash\/evidence\.md/);
  assert.match(src!, /Slim is not affiliated with the original package authors\./);
  assert.match(src!, /Differential fuzzing is evidence, not proof\./);
  assert.doesNotMatch(src!, /@license MIT/);
});

test("assemble tree-shakes _internal: get+debounce stays small and drops unused helpers", () => {
  const src = assembleCatalogModule(env(["get", "debounce"]));
  assert.ok(src);
  const lines = src!.split("\n").length;
  assert.ok(lines < 280, `assembled get+debounce is ${lines} lines; target under 280`);
  for (const name of ["baseIsEqual", "baseClone", "pickPaths", "forEachCollection", "words"]) {
    assert.doesNotMatch(src!, new RegExp(`\\b${name}\\b`), `must not contain ${name}`);
  }
});

test("export default only for default or namespace imports; named exports always", () => {
  const named = assembleCatalogModule(env(["get"], [{ kind: "named", names: ["get"] }]));
  assert.ok(named);
  assert.match(named!, /export function get/);
  assert.doesNotMatch(named!, /export default/);

  const empty = assembleCatalogModule(env(["get"]));
  assert.ok(empty);
  assert.doesNotMatch(empty!, /export default/);

  const def = assembleCatalogModule(env(["get"], [{ kind: "default", names: ["_"] }]));
  assert.ok(def);
  assert.match(def!, /export function get/);
  assert.match(def!, /export default \{/);

  const ns = assembleCatalogModule(env(["get"], [{ kind: "namespace", names: ["_"] }]));
  assert.ok(ns);
  assert.match(ns!, /export default \{/);
});

test("assembled get+debounce+set+has pass the AST allowlist", () => {
  const e = env(["get", "debounce", "set", "has"]);
  const src = assembleCatalogModule(e);
  assert.ok(src);
  const r = validateGenerated(ts, src!, { envelope: e });
  assert.equal(r.ok, true, r.errors.join("; "));
});

test("generated validator rejects computed and aliased escape hatches", () => {
  const sources = [
    'const k = "eval"; globalThis[k]("x");',
    'const g = globalThis; const k = "eval"; g[k]("x");',
    'Reflect.get(globalThis, "eval");',
    'const cc = ({}).constructor.constructor; cc("x");',
    'const p = ({}).__proto__; p.polluted = true;',
    'const k = "setPrototypeOf"; Object[k]({}, null);',
  ];
  for (const source of sources) assert.equal(validateGenerated(ts, source).ok, false, source);
});

test("assemble finds camelCase catalog files for whatwg-url and mime-types", () => {
  const urlEnv: Envelope = {
    ...env(["URL", "URLSearchParams"]),
    package: { name: "whatwg-url", version: "14", family: "whatwg-url", subpath: "" },
    clock: false,
  };
  const urlSrc = assembleCatalogModule(urlEnv);
  assert.ok(urlSrc, "assemble whatwg-url must not return null");
  assert.match(urlSrc!, /export const URL/);
  assert.match(urlSrc!, /URLSearchParams/);

  const mimeEnv: Envelope = {
    ...env(["lookup", "extension"]),
    package: { name: "mime-types", version: "2", family: "mime-types", subpath: "" },
    clock: false,
  };
  const mimeSrc = assembleCatalogModule(mimeEnv);
  assert.ok(mimeSrc, "assemble mime-types must not return null");
  assert.match(mimeSrc!, /export function lookup/);
  assert.match(mimeSrc!, /export function extension/);
});

test("generate assemble reads via OriginalSourceGuard, not raw lodash js", () => {
  const assemblePath = fileURLToPath(new URL("../src/generate/assemble.ts", import.meta.url));
  const src = readFileSync(assemblePath, "utf8");
  assert.match(src, /OriginalSourceGuard|guardedReadFileSync/);
  const validatePath = fileURLToPath(new URL("../src/generate/validate.ts", import.meta.url));
  const vsrc = readFileSync(validatePath, "utf8");
  assert.doesNotMatch(vsrc, /node_modules\/lodash\/.*\.js/);
});

function familyEnv(
  name: string,
  version: string,
  symbols: string[],
  importKind: ImportKind = "named",
): Envelope {
  const e = env(symbols, [{ kind: importKind, names: symbols }]);
  e.package = { name, version, family: name, subpath: "" };
  e.clock = symbols.includes("debounce") || symbols.includes("throttle") || symbols.includes("delay");
  e.cryptoRandom = name === "uuid" || name === "nanoid";
  for (const imp of e.imports) imp.specifier = name;
  return e;
}

test("each registered family assembles requested exports only, with SPDX provenance", () => {
  const cases: Array<{
    pkg: string;
    version: string;
    symbols: string[];
    kind: ImportKind;
    expect: RegExp[];
    absent: RegExp[];
  }> = [
    {
      pkg: "lodash",
      version: "4.17.21",
      symbols: ["get", "debounce"],
      kind: "named",
      expect: [/export function get/, /export function debounce/],
      absent: [/export function groupBy/, /from ["']lodash/],
    },
    {
      pkg: "moment",
      version: "2.30.1",
      symbols: ["default"],
      kind: "default",
      expect: [/export default/, /export const moment|export function createMoment/],
      absent: [/export function get\b/, /from ["']moment/],
    },
    {
      pkg: "uuid",
      version: "11.1.0",
      symbols: ["v4"],
      kind: "named",
      expect: [/export function v4/, /globalThis\.crypto/],
      absent: [/from ["']uuid/, /export function get\b/],
    },
    {
      pkg: "ms",
      version: "2.1.3",
      symbols: ["default"],
      kind: "default",
      expect: [/export default/, /export function ms/],
      absent: [/from ["']ms["']/, /export function get\b/],
    },
    {
      pkg: "nanoid",
      version: "5.1.5",
      symbols: ["nanoid"],
      kind: "named",
      expect: [/export function nanoid/, /globalThis\.crypto/],
      absent: [/from ["']nanoid/, /export function get\b/],
    },
    {
      pkg: "clsx",
      version: "2.1.1",
      symbols: ["clsx"],
      kind: "named",
      expect: [/export function clsx/],
      absent: [/from ["']clsx/, /export function get\b/],
    },
    {
      pkg: "whatwg-url",
      version: "14.2.0",
      symbols: ["URL", "URLSearchParams"],
      kind: "named",
      expect: [/export const URL/, /URLSearchParams/],
      absent: [/from ["']whatwg-url/, /export function get\b/],
    },
    {
      pkg: "bluebird",
      version: "3.7.2",
      symbols: ["delay", "resolve"],
      kind: "named",
      expect: [/export function delay/, /export function resolve/],
      absent: [/from ["']bluebird/, /export function get\b/],
    },
    {
      pkg: "mime-types",
      version: "2.1.35",
      symbols: ["lookup"],
      kind: "named",
      expect: [/export function lookup/],
      absent: [/from ["']mime-types/, /export function get\b/],
    },
  ];

  for (const c of cases) {
    const e = familyEnv(c.pkg, c.version, c.symbols, c.kind);
    const src = assembleCatalogModule(e);
    assert.ok(src, `${c.pkg}: assemble must not return null`);
    assert.match(src!, /^\s*\/\*\*\n \* SPDX-License-Identifier: MIT\n/m, c.pkg);
    assert.doesNotMatch(src!, /@license/, c.pkg);
    assert.doesNotMatch(src!, /Copyright .+ OpenJS/, c.pkg);
    for (const re of c.expect) assert.match(src!, re, `${c.pkg} ${re}`);
    for (const re of c.absent) assert.doesNotMatch(src!, re, `${c.pkg} ${re}`);
    const val = validateGenerated(ts, src!, { envelope: e });
    assert.equal(val.ok, true, `${c.pkg}: ${val.errors.join("; ")}`);
  }
});
