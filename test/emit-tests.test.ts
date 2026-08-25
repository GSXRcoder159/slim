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
      staticCallSiteIds: [],
      tracedCallSiteIds: [],
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

function spawnTest(file: string, cwd: string) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, ["--experimental-strip-types", "--test", file], {
    encoding: "utf8",
    cwd,
    env,
  });
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
  assert.match(body, /checkFrozenPair/);
  assert.match(body, /standingEqual/);
  assert.doesNotMatch(body, /from ["']lodash["']/);
  assert.doesNotMatch(body, /require\(["']lodash["']\)/);

  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { scripts?: Record<string, string> };
  assert.ok(pkg.scripts?.["slim:evidence"]);

  const r = spawnTest(file, dir);
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
  assert.match(body, /flush-mid/);
  assert.match(body, /flush-empty/);
  assert.match(body, /advance\(/);
  assert.doesNotMatch(body, /from ["']lodash["']/);

  const r = spawnTest(file, dir);
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
  const r = spawnTest(file, dir);
  assert.equal(r.status, 0, r.stderr + r.stdout);
});

test("standing frozen pairs drop unseeded CSPRNG hits and keep uuid random injects", () => {
  const dir = tmpProject();
  writeFileSync(
    join(dir, "src", "uuid.ts"),
    `export function v4(opts?: { random?: Uint8Array }) {
  if (opts?.random) return "seeded";
  return "live";
}
export function nanoid() { return "live"; }
`,
  );
  const e = env({ symbols: ["v4", "nanoid"] });
  e.package = { name: "uuid", version: "11.1.0", family: "uuid", subpath: "" };
  e.cryptoRandom = true;
  const file = emitStandingTests({
    root: dir,
    outDir: "src",
    pkg: "uuid",
    env: e,
    traces: [
      {
        symbol: "nanoid",
        args: [{ t: "num", v: 10 }],
        result: { t: "str", v: "abcdefghij" },
      },
      {
        symbol: "v4",
        args: [],
        result: { t: "str", v: "live-uuid" },
      },
      {
        symbol: "v4",
        args: [
          {
            t: "obj",
            keys: ["random"],
            v: { random: { t: "bytes", kind: "u8", len: 16, b64: "AAAAAAAAAAAAAAAAAAAAAA==" } },
          },
        ],
        result: { t: "str", v: "seeded" },
      },
    ],
    runner: "node:test",
    moduleSpecifier: "./uuid.ts",
  });
  const body = readFileSync(file, "utf8");
  assert.doesNotMatch(body, /abcdefghij/);
  assert.doesNotMatch(body, /live-uuid/);
  assert.match(body, /seeded/);
  const r = spawnTest(file, dir);
  assert.equal(r.status, 0, r.stderr + r.stdout);
});

test("standing frozen pairs drop URL host-object results that revive cannot rebuild", () => {
  const dir = tmpProject();
  writeFileSync(join(dir, "src", "whatwg-url.ts"), `export class URL {
  constructor(href: string) { this.href = href; this.hostname = "example.com"; }
}
`);
  const e = env({ symbols: ["URL"] });
  e.package = { name: "whatwg-url", version: "14.2.0", family: "whatwg-url", subpath: "" };
  const file = emitStandingTests({
    root: dir,
    outDir: "src",
    pkg: "whatwg-url",
    env: e,
    traces: [
      {
        symbol: "URL",
        args: [{ t: "str", v: "https://example.com/" }],
        result: { t: "obj", keys: [], v: {}, proto: "other", toStr: true },
      },
      {
        symbol: "URL",
        args: [{ t: "str", v: "nope" }],
        threw: { name: "TypeError", message: "Invalid URL" },
      },
    ],
    runner: "node:test",
    moduleSpecifier: "./whatwg-url.ts",
  });
  const body = readFileSync(file, "utf8");
  assert.doesNotMatch(body, /https:\/\/example.com\//);
  assert.match(body, /Invalid URL/);
});

test("standing frozen pairs keep envelope symbols and drop wrapped internals", () => {
  const dir = tmpProject();
  writeFileSync(
    join(dir, "src", "bluebird.ts"),
    `export function resolve(v: unknown) { return Promise.resolve(v); }
export class Promise extends globalThis.Promise {}
`,
  );
  const e = env({ symbols: ["resolve"] });
  e.package = { name: "bluebird", version: "3.7.2", family: "bluebird", subpath: "" };
  const file = emitStandingTests({
    root: dir,
    outDir: "src",
    pkg: "bluebird",
    env: e,
    traces: [
      {
        symbol: "Promise",
        args: [{ t: "num", v: 16 }],
        result: { t: "promise" },
      },
      {
        symbol: "resolve",
        args: [{ t: "str", v: "ok" }],
        result: { t: "promise" },
      },
    ],
    runner: "node:test",
    moduleSpecifier: "./bluebird.ts",
  });
  const body = readFileSync(file, "utf8");
  assert.doesNotMatch(body, /"symbol": "Promise"/);
  assert.doesNotMatch(body, /"symbol": "resolve"/);
  const r = spawnTest(file, dir);
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
  assert.match(body, /checkFrozenPair/);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { scripts?: Record<string, string> };
  assert.match(pkg.scripts!["slim:evidence"]!, /vitest/);
});

test("standing revive uses null-prototype objects and defineProperty", () => {
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
          {
            t: "obj",
            keys: ["__proto__", "a"],
            v: { __proto__: { t: "str", v: "nope" }, a: { t: "num", v: 1 } },
          },
          { t: "str", v: "a" },
        ],
        result: { t: "num", v: 1 },
      },
    ],
    runner: "node:test",
    moduleSpecifier: "./lodash.ts",
  });
  const body = readFileSync(file, "utf8");
  assert.match(body, /Object\.create\(null\)/);
  assert.match(body, /defineProperty/);
  const before = Object.prototype.hasOwnProperty("polluted");
  const r = spawnTest(file, dir);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(Object.prototype.hasOwnProperty("polluted"), before);
});

test("standing tests fail a cloning replacement when result is a ref", () => {
  const dir = tmpProject();
  writeFileSync(
    join(dir, "src", "lodash.ts"),
    `export function get(object: { nested: { n: number } }) {\n  return { ...object.nested };\n}\n`,
  );
  const e = env({ symbols: ["get"] });
  e.symbols[0]!.hyrum = { ...emptyHyrum(), sameReference: true };
  const file = emitStandingTests({
    root: dir,
    outDir: "src",
    pkg: "lodash",
    env: e,
    traces: [
      {
        symbol: "get",
        args: [
          {
            t: "obj",
            keys: ["nested"],
            v: {
              nested: {
                t: "obj",
                keys: ["n"],
                v: { n: { t: "num", v: 1 } },
              },
            },
          },
        ],
        result: { t: "ref", id: 1 },
      },
    ],
    runner: "node:test",
    moduleSpecifier: "./lodash.ts",
  });
  const r = spawnTest(file, dir);
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /identity mismatch|standing mismatch/i);
});

test("standing tests pass identity-preserving get for ref results", () => {
  const dir = tmpProject();
  writeFileSync(
    join(dir, "src", "lodash.ts"),
    `export function get(object: { nested: { n: number } }) {\n  return object.nested;\n}\n`,
  );
  const e = env({ symbols: ["get"] });
  e.symbols[0]!.hyrum = { ...emptyHyrum(), sameReference: true };
  const file = emitStandingTests({
    root: dir,
    outDir: "src",
    pkg: "lodash",
    env: e,
    traces: [
      {
        symbol: "get",
        args: [
          {
            t: "obj",
            keys: ["nested"],
            v: {
              nested: {
                t: "obj",
                keys: ["n"],
                v: { n: { t: "num", v: 1 } },
              },
            },
          },
        ],
        result: { t: "ref", id: 1 },
      },
    ],
    runner: "node:test",
    moduleSpecifier: "./lodash.ts",
  });
  const r = spawnTest(file, dir);
  assert.equal(r.status, 0, r.stderr + r.stdout);
});

test("standing tests compare post-call arg mutation when argsAfter is frozen", () => {
  const dir = tmpProject();
  writeFileSync(
    join(dir, "src", "lodash.ts"),
    `export function pull(arr: unknown[], value: unknown) {
  const i = arr.indexOf(value);
  if (i >= 0) arr.splice(i, 1);
  return arr;
}
`,
  );
  const file = emitStandingTests({
    root: dir,
    outDir: "src",
    pkg: "lodash",
    env: env({ symbols: ["pull"] }),
    traces: [
      {
        symbol: "pull",
        args: [
          { t: "arr", v: [{ t: "num", v: 1 }, { t: "num", v: 2 }], holes: [] },
          { t: "num", v: 1 },
        ],
        result: { t: "ref", id: 0 },
        argsAfter: [
          { t: "arr", v: [{ t: "num", v: 2 }], holes: [] },
          { t: "num", v: 1 },
        ],
      },
    ],
    runner: "node:test",
    moduleSpecifier: "./lodash.ts",
  });
  const body = readFileSync(file, "utf8");
  assert.match(body, /argsAfter/);
  const r = spawnTest(file, dir);
  assert.equal(r.status, 0, r.stderr + r.stdout);
});
