import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  ENVELOPE_VERSION,
  emptyHyrum,
  type Envelope,
} from "../../src/envelope/types.ts";
import { runFuzz } from "../../src/fuzz/run.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const catalogGet = join(root, "src", "generate", "catalog", "lodash.get.ts");
const catalogDebounce = join(root, "src", "generate", "catalog", "lodash.debounce.ts");
const require = createRequire(join(root, "package.json"));

let lodashSkip = "";
try {
  require("lodash");
} catch {
  lodashSkip = "lodash is not installed";
}

function loc() {
  return { file: "t.ts", line: 1, column: 0, endLine: 1, endColumn: 10 };
}

function envelopeGet(): Envelope {
  return {
    schemaVersion: ENVELOPE_VERSION,
    package: { name: "lodash", version: "4.17.21", family: "lodash", subpath: "." },
    env: ["node"],
    imports: [],
    symbols: [
      {
        exportName: "get",
        packages: [{ name: "lodash", version: "4.17.21", family: "lodash", subpath: "." }],
        callSites: [
          {
            id: "c1",
            loc: loc(),
            exportName: "get",
            memberPath: ["get"],
            thisBinding: { kind: "unbound" },
            argc: { min: 2, max: 3, observed: [2] },
            argShapes: [
              {
                kind: "object",
                props: { a: { kind: "literal", literals: [1] } },
              },
              { kind: "literal", literals: ["a"] },
            ],
            spread: false,
            resultMembers: [],
          },
        ],
        resultMembers: [],
        hyrum: emptyHyrum(),
        coverage: { callSitesStatic: 1, callSitesTraced: 0 },
      },
    ],
    unknowns: [],
    traces: [
      {
        symbol: "get",
        args: [
          {
            t: "obj",
            keys: ["a"],
            v: { a: { t: "num", v: 1 } },
          },
          { t: "str", v: "a" },
        ],
      },
    ],
    closure: {
      confidence: "closed",
      readyToGenerate: true,
      untracedCallSiteIds: [],
      reason: "workers",
    },
    slimmable: { score: 1, verdict: "slim", blockers: [], reasons: [] },
    clock: false,
    cryptoRandom: false,
  };
}

function envelopeDebounce(): Envelope {
  return {
    schemaVersion: ENVELOPE_VERSION,
    package: { name: "lodash", version: "4.17.21", family: "lodash", subpath: "." },
    env: ["node"],
    imports: [],
    symbols: [
      {
        exportName: "debounce",
        packages: [{ name: "lodash", version: "4.17.21", family: "lodash", subpath: "." }],
        callSites: [
          {
            id: "d1",
            loc: loc(),
            exportName: "debounce",
            memberPath: ["debounce"],
            thisBinding: { kind: "unbound" },
            argc: { min: 2, max: 2, observed: [2] },
            argShapes: [
              { kind: "function", fnArity: 0 },
              { kind: "literal", literals: [32] },
            ],
            spread: false,
            resultMembers: ["cancel", "flush"],
          },
        ],
        resultMembers: ["cancel", "flush"],
        hyrum: emptyHyrum(),
        coverage: { callSitesStatic: 1, callSitesTraced: 0 },
      },
    ],
    unknowns: [],
    traces: [],
    closure: {
      confidence: "closed",
      readyToGenerate: true,
      untracedCallSiteIds: [],
      reason: "workers",
    },
    slimmable: { score: 1, verdict: "slim", blockers: [], reasons: [] },
    clock: true,
    cryptoRandom: false,
  };
}

test(
  "workers>1 pool actually runs at least one case",
  { skip: lodashSkip || (!existsSync(catalogGet) ? "catalog lodash.get is not ready" : false) },
  async () => {
    const report = await runFuzz({
      origModule: "lodash",
      slimModule: catalogGet,
      slimHash: "workers-get-1",
      envelope: envelopeGet(),
      budgetMs: 80,
      seed: 11,
      workers: 2,
    });
    assert.ok(report.cases > 0, "pool must run at least one case");
    assert.equal(
      report.disagreements.length,
      0,
      report.disagreements.map((d) => d.reason).join("; "),
    );
  },
);

test(
  "lodash debounce agrees under fake clock in a worker when workers=2",
  {
    skip:
      lodashSkip ||
      (!existsSync(catalogDebounce) ? "catalog lodash.debounce is not ready" : false),
  },
  async () => {
    const report = await runFuzz({
      origModule: "lodash",
      slimModule: catalogDebounce,
      slimHash: "workers-debounce-1",
      envelope: envelopeDebounce(),
      budgetMs: 50,
      seed: 12,
      workers: 2,
    });
    assert.ok(report.cases > 0);
    assert.ok(report.timerCases > 0);
    assert.equal(
      report.disagreements.length,
      0,
      report.disagreements.map((d) => `${d.reason}`).join("; "),
    );
  },
);
