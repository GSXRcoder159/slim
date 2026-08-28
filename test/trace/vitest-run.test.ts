import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnPm } from "../../src/rewrite/lockfile.ts";
import { ENVELOPE_VERSION, emptyHyrum, type Envelope } from "../../src/envelope/types.ts";
import { runTraces } from "../../src/trace/run.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURE = join(ROOT, "test/fixtures/trace/esm");

function env(): Envelope {
  return {
    schemaVersion: ENVELOPE_VERSION,
    package: { name: "tiny-trace-esm", version: "1.0.0", family: "tiny-trace-esm", subpath: "" },
    env: ["node"],
    imports: [],
    symbols: [
      {
        exportName: "get",
        packages: [],
        callSites: [
          {
            id: "call:src/app.test.js:1",
            loc: { file: "src/app.test.js", line: 1, column: 1, endLine: 1, endColumn: 10 },
            exportName: "get",
            memberPath: [],
            thisBinding: { kind: "unbound" },
            argc: { min: 2, max: 2, observed: [2] },
            argShapes: [],
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
    traces: [],
    closure: {
      confidence: "closed",
      readyToGenerate: true,
      staticCallSiteIds: ["call:src/app.test.js:1"],
      tracedCallSiteIds: [],
      untracedCallSiteIds: ["call:src/app.test.js:1"],
      reason: "",
    },
    slimmable: { score: 80, verdict: "slim", blockers: [], reasons: [] },
    clock: false,
    cryptoRandom: false,
  };
}

test("vitest named import { get } records wrapped events", { timeout: 120_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-vitest-run-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "app",
      type: "module",
      scripts: { test: "vitest run" },
      devDependencies: { vitest: "3.2.4" },
    }),
  );
  writeFileSync(
    join(dir, "src", "app.test.js"),
    `import { test, expect } from "vitest";
import { get } from "tiny-trace-esm";
test("named get", () => {
  expect(get({ a: 1 }, "a")).toBe(1);
});
`,
  );
  const inst = spawnPm("npm", ["install", "--omit=peer", "--no-audit", "--no-fund"], {
    cwd: dir,
    encoding: "utf8",
    timeout: 90_000,
  });
  assert.equal(inst.status, 0, String(inst.stderr) + String(inst.stdout));
  const pkgDir = join(dir, "node_modules", "tiny-trace-esm");
  mkdirSync(pkgDir, { recursive: true });
  cpSync(FIXTURE, pkgDir, { recursive: true });
  const out = runTraces(dir, "tiny-trace-esm", env());
  assert.ok(out.traces.some((t) => t.symbol === "get"), JSON.stringify(out.traces.map((t) => t.symbol)));
});
