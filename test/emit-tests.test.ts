import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { emitStandingTests } from "../src/evidence/emit-tests.ts";
import { ENVELOPE_VERSION, emptyHyrum } from "../src/envelope/types.ts";
import type { CallSite, Envelope } from "../src/envelope/types.ts";

const LOC = { file: "x.ts", line: 1, column: 0, endLine: 1, endColumn: 10 };

function env(opts: {
  symbols: string[];
  callSites?: CallSite[];
}): Envelope {
  const symbols = opts.symbols;
  return {
    schemaVersion: ENVELOPE_VERSION,
    package: { name: "lodash", version: "4.17.21", family: "lodash", subpath: "" },
    env: ["node"],
    imports: [],
    symbols: symbols.map((exportName) => ({
      exportName,
      packages: [],
      callSites: exportName === "debounce" ? (opts.callSites ?? []) : [],
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

function tmpProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "slim-standing-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", scripts: {} }, null, 2) + "\n");
  mkdirSync(join(dir, "src"), { recursive: true });
  return dir;
}

test("standing tests deep-equal revived frozen results and do not import the original", () => {
  const dir = tmpProject();
  writeFileSync(
    join(dir, "src", "lodash.ts"),
    `export function get(object: Record<string, unknown>, path: string) {\n  return object[path];\n}\n`,
  );
  const file = emitStandingTests({
    root: dir,
    outDir: "src",
    pkg: "lodash",
    env: env({ symbols: ["get"] }),
    traces: [
      {
        symbol: "get",
        args: [
          { t: "obj", keys: ["a"], v: { a: { t: "num", v: 1 } } },
          { t: "str", v: "a" },
        ],
        result: { t: "num", v: 1 },
      },
      {
        symbol: "get",
        args: [
          { t: "obj", keys: ["x"], v: { x: { t: "str", v: "hi" } } },
          { t: "str", v: "x" },
        ],
        result: { t: "str", v: "hi" },
      },
    ],
    runner: "node:test",
    moduleSpecifier: "./lodash.ts",
  });
  const body = readFileSync(file, "utf8");
  assert.match(body, /deepEqual/);
  assert.match(body, /revive\(p\.result\)/);
  assert.doesNotMatch(body, /from ["']lodash["']/);
  assert.doesNotMatch(body, /require\(["']lodash["']\)/);

  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { scripts?: Record<string, string> };
  assert.ok(pkg.scripts?.["slim:evidence"]);

  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--test", file], {
    encoding: "utf8",
    cwd: dir,
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
});

test("debounce standing tests use an inline fake clock, not wall-clock setTimeout", () => {
  const dir = tmpProject();
  const catalogDebounce = new URL("../src/generate/catalog/lodash.debounce.ts", import.meta.url).href;
  const file = emitStandingTests({
    root: dir,
    outDir: "src",
    pkg: "lodash",
    env: env({ symbols: ["debounce"] }),
    traces: [],
    runner: "node:test",
    moduleSpecifier: catalogDebounce,
  });
  const body = readFileSync(file, "utf8");
  assert.doesNotMatch(body, /await new Promise/);
  assert.doesNotMatch(body, /await .+setTimeout/);
  assert.match(body, /cancel-mid/);
  assert.match(body, /trailing-single/);
  assert.match(body, /advance\(/);
  assert.doesNotMatch(body, /from ["']lodash["']/);

  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--test", file], {
    encoding: "utf8",
    cwd: dir,
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
});

test("debounce standing tests include observed option scripts", () => {
  const dir = tmpProject();
  const file = emitStandingTests({
    root: dir,
    outDir: "src",
    pkg: "lodash",
    env: env({
      symbols: ["debounce"],
      callSites: [
        {
          id: "c1",
          loc: LOC,
          exportName: "debounce",
          memberPath: [],
          thisBinding: { kind: "unbound" },
          argc: { min: 3, max: 3, observed: [3] },
          argShapes: [
            { kind: "function", fnArity: 0 },
            { kind: "literal", literals: [32] },
            { kind: "object", props: { leading: { kind: "literal", literals: [true] } } },
          ],
          spread: false,
          resultMembers: ["cancel", "flush"],
        },
      ],
    }),
    traces: [],
    runner: "node:test",
    moduleSpecifier: "./lodash.ts",
  });
  const body = readFileSync(file, "utf8");
  assert.match(body, /leading-only/);
  assert.match(body, /cancel-mid/);
  assert.match(body, /trailing-single/);
});

test("standing frozen pairs skip debounce function I/O and keep throw traces", () => {
  const dir = tmpProject();
  const catalogDebounce = new URL("../src/generate/catalog/lodash.debounce.ts", import.meta.url).href;
  writeFileSync(
    join(dir, "src", "lodash.ts"),
    `export { debounce } from ${JSON.stringify(catalogDebounce)};
export function get(object: Record<string, unknown>, path: string) {
  return object[path];
}
`,
  );
  const file = emitStandingTests({
    root: dir,
    outDir: "src",
    pkg: "lodash",
    env: env({ symbols: ["get", "debounce"] }),
    traces: [
      {
        symbol: "get",
        args: [
          { t: "obj", keys: ["a"], v: { a: { t: "num", v: 1 } } },
          { t: "str", v: "a" },
        ],
        result: { t: "num", v: 1 },
      },
      {
        symbol: "debounce",
        args: [
          { t: "fn", length: 1, name: "ping" },
          { t: "num", v: 50 },
        ],
        result: { t: "fn", length: 0, name: "debounced" },
      },
      {
        symbol: "debounce",
        args: [
          { t: "null" },
          { t: "num", v: 10 },
        ],
        threw: { name: "TypeError", message: "Expected a function" },
      },
      {
        symbol: "debounce()",
        args: [{ t: "num", v: 1 }],
        result: { t: "undef" },
      },
    ],
    runner: "node:test",
    moduleSpecifier: "./lodash.ts",
  });
  const body = readFileSync(file, "utf8");
  assert.match(body, /Expected a function/);
  assert.match(body, /"symbol": "get"/);
  assert.doesNotMatch(body, /"name": "debounced"/);
  assert.doesNotMatch(body, /"symbol": "debounce\(\)"/);
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--test", file], {
    encoding: "utf8",
    cwd: dir,
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
});

test("vitest flavor standing tests import vitest", () => {
  const dir = tmpProject();
  const file = emitStandingTests({
    root: dir,
    outDir: "src",
    pkg: "lodash",
    env: env({ symbols: ["get"] }),
    traces: [
      {
        symbol: "get",
        args: [
          { t: "obj", keys: ["a"], v: { a: { t: "num", v: 1 } } },
          { t: "str", v: "a" },
        ],
        result: { t: "num", v: 1 },
      },
    ],
    runner: "vitest",
    moduleSpecifier: "./lodash.ts",
  });
  const body = readFileSync(file, "utf8");
  assert.match(body, /from ["']vitest["']/);
  assert.match(body, /toEqual/);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { scripts?: Record<string, string> };
  assert.match(pkg.scripts!["slim:evidence"]!, /vitest/);
});
