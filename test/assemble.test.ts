import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleCatalogModule } from "../src/generate/assemble.ts";
import { ENVELOPE_VERSION, emptyHyrum } from "../src/envelope/types.ts";
import type { Envelope } from "../src/envelope/types.ts";

function env(symbols: string[]): Envelope {
  return {
    schemaVersion: ENVELOPE_VERSION,
    package: { name: "lodash", version: "4.17.21", family: "lodash", subpath: "" },
    env: ["node"],
    imports: [],
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
      untracedCallSiteIds: [],
      reason: "test",
    },
    slimmable: { score: 80, verdict: "slim", blockers: [], reasons: [] },
    clock: symbols.includes("debounce"),
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
  assert.match(src!, /export default/);
});
