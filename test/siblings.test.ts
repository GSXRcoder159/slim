import { test } from "node:test";
import assert from "node:assert/strict";
import { removeDependencyNames, rewriteSpecifiers } from "../src/rewrite/siblings.ts";
import { resolvePackageFamily } from "../src/analyze/family.ts";
import { ENVELOPE_VERSION, emptyHyrum } from "../src/envelope/types.ts";
import type { Envelope, ImportSite } from "../src/envelope/types.ts";

function site(specifier: string, file = "src/index.ts"): ImportSite {
  return { loc: { file, line: 1, column: 1 }, specifier, kind: "named", names: ["get"] };
}

function env(over: Partial<Envelope> & { imports: ImportSite[]; package: Envelope["package"] }): Envelope {
  return {
    schemaVersion: ENVELOPE_VERSION,
    env: ["node"],
    symbols: [
      {
        exportName: "get",
        packages: [],
        callSites: [],
        resultMembers: [],
        hyrum: emptyHyrum(),
        coverage: { callSitesStatic: 0, callSitesTraced: 0 },
      },
    ],
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
    ...over,
  };
}

test("rewrite specifiers are import sites plus the replaced package, not unused aliases", () => {
  const e = env({
    package: { name: "lodash", version: "4.17.21", family: "lodash", subpath: "" },
    imports: [site("lodash")],
  });
  const specs = rewriteSpecifiers(e, "lodash");
  assert.equal(specs.has("lodash"), true);
  assert.equal(specs.has("lodash-es"), false);
  assert.equal(specs.has("underscore"), false);
});

test("used lodash-es is rewritten and removed; unused lodash-es stays", () => {
  const used = env({
    package: { name: "lodash", version: "4.17.21", family: "lodash", subpath: "" },
    imports: [site("lodash"), site("lodash-es", "src/other.ts")],
  });
  assert.equal(rewriteSpecifiers(used, "lodash").has("lodash-es"), true);
  const declared = ["lodash", "lodash-es", "left-pad"];
  assert.deepEqual([...removeDependencyNames(used, declared)].sort(), ["lodash", "lodash-es"].sort());
  const unused = env({
    package: { name: "lodash", version: "4.17.21", family: "lodash", subpath: "" },
    imports: [site("lodash")],
  });
  assert.deepEqual([...removeDependencyNames(unused, declared)].sort(), ["lodash"]);
});

test("per-method lodash.get is removed when it has import sites", () => {
  const e = env({
    package: { name: "lodash", version: "4.17.21", family: "lodash", subpath: "" },
    imports: [site("lodash.get")],
  });
  assert.equal(rewriteSpecifiers(e, "lodash").has("lodash.get"), true);
  assert.deepEqual(
    [...removeDependencyNames(e, ["lodash", "lodash.get"])].sort(),
    ["lodash", "lodash.get"].sort(),
  );
});

test("unused classnames stays when replacing clsx", () => {
  const e = env({
    package: { name: "clsx", version: "2.1.1", family: "clsx", subpath: "" },
    imports: [{ loc: { file: "src/index.ts", line: 1, column: 1 }, specifier: "clsx", kind: "named", names: ["clsx"] }],
  });
  assert.deepEqual([...removeDependencyNames(e, ["clsx", "classnames"])], ["clsx"]);
  assert.equal(resolvePackageFamily("classnames")?.family, "clsx");
});
