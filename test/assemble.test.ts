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

test("assemble get+debounce is standalone and names the exports", () => {
  const src = assembleCatalogModule(env(["get", "debounce"]));
  assert.ok(src);
  assert.match(src!, /export function get/);
  assert.match(src!, /export function debounce/);
  assert.match(src!, /EVIDENCE, NOT PROOF|evidence, not proof/i);
  assert.doesNotMatch(src!, /from ["']lodash/);
});

test("assembled header uses SPDX MIT and exact provenance lines", () => {
  const src = assembleCatalogModule(env(["get", "debounce"]));
  assert.ok(src);
  assert.ok(src!.startsWith("/**"), "header must be the first lines");
  assert.match(src!, /^\s*\/\*\*\n \* SPDX-License-Identifier: MIT\n/m);
  assert.match(src!, /Original implementation, not derived from lodash, Underscore, or OpenJS\./);
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
