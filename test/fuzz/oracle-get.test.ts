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
const catalogPath = join(root, "src", "generate", "catalog", "lodash.get.ts");
const require = createRequire(join(root, "package.json"));

let lodashGet: Function | null = null;
let lodashSkip = "";
try {
  const _ = require("lodash") as { get: Function };
  lodashGet = _.get.bind(_);
} catch {
  lodashSkip = "lodash is not installed";
}

const catalogSkip = existsSync(catalogPath)
  ? ""
  : "catalog lodash.get is not ready";

test(
  "oracle: catalog get vs lodash.get for 200ms",
  { skip: lodashSkip || catalogSkip || false },
  async () => {
    if (!lodashGet) {
      assert.ok(false, lodashSkip || "lodash missing");
      return;
    }
    const mod = await import(
      new URL("../../src/generate/catalog/lodash.get.ts", import.meta.url).href
    );
    const catalogGet = (mod as { get?: Function }).get ?? (mod as { default?: Function }).default;
    assert.equal(typeof catalogGet, "function", "catalog must export get");

    const envelope: Envelope = {
      schemaVersion: ENVELOPE_VERSION,
      package: { name: "lodash", version: "4.17.21", family: "lodash", subpath: "." },
      env: ["node"],
      imports: [],
      symbols: [
        {
          exportName: "get",
          packages: [
            { name: "lodash", version: "4.17.21", family: "lodash", subpath: "." },
          ],
          callSites: [
            {
              id: "c1",
              loc: { file: "t.ts", line: 1, column: 0, endLine: 1, endColumn: 1 },
              exportName: "get",
              memberPath: ["get"],
              thisBinding: { kind: "unbound" },
              argc: { min: 2, max: 3, observed: [2, 3] },
              argShapes: [
                {
                  kind: "object",
                  props: {
                    a: {
                      kind: "object",
                      props: { b: { kind: "literal", literals: [1, "x"] } },
                    },
                  },
                },
                { kind: "literal", literals: ["a.b", "a", "missing"] },
                { kind: "literal", literals: [undefined, 0, "def"] },
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
              v: {
                a: {
                  t: "obj",
                  keys: ["b"],
                  v: { b: { t: "num", v: 1 } },
                },
              },
            },
            { t: "str", v: "a.b" },
          ],
        },
      ],
      closure: {
        confidence: "closed",
        readyToGenerate: true,
        untracedCallSiteIds: [],
        reason: "oracle",
      },
      slimmable: { score: 1, verdict: "slim", blockers: [], reasons: [] },
      clock: false,
      cryptoRandom: false,
    };

    const report = await runFuzz({
      original: { get: lodashGet },
      replacement: { get: catalogGet as Function },
      envelope,
      budgetMs: 200,
      seed: 7,
    });
    assert.equal(
      report.disagreements.length,
      0,
      report.disagreements.map((d) => d.reason).join("; "),
    );
    assert.ok(report.comparisons > 0);
  },
);
