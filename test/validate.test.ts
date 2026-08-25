import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ts from "typescript";
import { validateGenerated } from "../src/generate/validate.ts";
import { OriginalSourceGuard } from "../src/generate/guard.ts";
import { assembleCatalogModule } from "../src/generate/assemble.ts";
import { ENVELOPE_VERSION, emptyHyrum } from "../src/envelope/types.ts";
import type { Envelope, EnvKind } from "../src/envelope/types.ts";

const LOC = { file: "x.ts", line: 1, column: 0, endLine: 1, endColumn: 10 };

function env(symbols: string[], kinds: EnvKind[] = ["node"]): Envelope {
  return {
    schemaVersion: ENVELOPE_VERSION,
    package: { name: "lodash", version: "4.17.21", family: "lodash", subpath: "" },
    env: kinds,
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

test("allowlist accepts ordinary get", () => {
  const src = `export function get(o, p) { return o == null ? undefined : o[p]; }\n`;
  const r = validateGenerated(ts, src);
  assert.equal(r.ok, true, r.errors.join("; "));
});

test("allowlist rejects eval and Function", () => {
  assert.equal(validateGenerated(ts, `export const x = eval("1")`).ok, false);
  assert.equal(validateGenerated(ts, `export const F = new Function("return 1")`).ok, false);
});

test("allowlist rejects lodash import", () => {
  const r = validateGenerated(ts, `import get from "lodash/get";\nexport { get }\n`);
  assert.equal(r.ok, false);
});

test("fail-closed allowlist rejects console, process, fetch, Proxy, WebAssembly, require, import(), node: specifiers, string-setTimeout", () => {
  const cases = [
    `export const x = console.log;`,
    `export const x = process.exit;`,
    `export const x = fetch;`,
    `export const x = new Proxy({}, {});`,
    `export const x = WebAssembly;`,
    `export const x = require("fs");`,
    `export async function f() { return import("fs"); }`,
    `import fs from "node:fs";\nexport const x = 1;`,
    `export const t = setTimeout("alert(1)", 0);`,
  ];
  for (const src of cases) {
    const r = validateGenerated(ts, src);
    assert.equal(r.ok, false, `expected reject: ${src}`);
  }
});

test("allowlist accepts real catalog get/debounce/set/has (Object, Array, Date.now at call time)", () => {
  for (const symbols of [["get"], ["debounce"], ["set"], ["has"], ["get", "debounce", "set", "has"]]) {
    const e = env(symbols);
    const src = assembleCatalogModule(e);
    assert.ok(src, `assemble ${symbols.join("+")}`);
    const r = validateGenerated(ts, src!, { envelope: e });
    assert.equal(r.ok, true, `${symbols.join("+")}: ${r.errors.join("; ")}`);
  }
});

test("Buffer is allowed only when envelope env includes node", () => {
  const src = `export function isBuf(x: unknown) {\n  return typeof Buffer !== "undefined" && Buffer.isBuffer(x);\n}\n`;
  const nodeR = validateGenerated(ts, src, { envelope: env(["get"], ["node"]) });
  assert.equal(nodeR.ok, true, nodeR.errors.join("; "));
  const workerR = validateGenerated(ts, src, { envelope: env(["get"], ["worker"]) });
  assert.equal(workerR.ok, false, "Buffer must be rejected for worker env");
  const omitted = validateGenerated(ts, src);
  assert.equal(omitted.ok, false, "Buffer must be rejected when envelope env is omitted");
});

test("cached-timers fails module-scope Date.now/setTimeout/clearTimeout capture", () => {
  const bad = `
const now = Date.now;
const st = setTimeout;
const ct = clearTimeout;
export function debounce(fn: () => void, wait?: number) {
  const t = st(() => fn(), wait ?? 0);
  const wrapped = () => now();
  wrapped.cancel = () => ct(t);
  wrapped.flush = () => undefined;
  return wrapped;
}
`;
  const r = validateGenerated(ts, bad, { envelope: env(["debounce"]) });
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some((e) => /cached-timers/i.test(e)),
    `expected cached-timers in errors, got: ${r.errors.join("; ")}`,
  );
});

test("catalog debounce (call-time timer lookup) is not cached-timers", () => {
  const e = env(["debounce"]);
  const src = assembleCatalogModule(e);
  assert.ok(src);
  const r = validateGenerated(ts, src!, { envelope: e });
  assert.equal(r.ok, true, r.errors.join("; "));
  assert.equal(r.errors.some((err) => /cached-timers/i.test(err)), false);
});

test("constructor/__proto__ literal keys allowed only in hardened get/set/has", () => {
  const poisoned = `export function map(o: object) { return { __proto__: o, constructor: 1 }; }\n`;
  const r = validateGenerated(ts, poisoned);
  assert.equal(r.ok, false, "literal __proto__/constructor keys forbidden outside get/set/has");

  const e = env(["get", "set", "has"]);
  const src = assembleCatalogModule(e);
  assert.ok(src);
  const ok = validateGenerated(ts, src!, { envelope: e });
  assert.equal(ok.ok, true, ok.errors.join("; "));
});

test("a function param named console does not allowlist console at module level", () => {
  const src = `
export function use(console: unknown) {
  return console;
}
export const leaked = console.log;
`;
  const r = validateGenerated(ts, src);
  assert.equal(r.ok, false, "module-level console.log must fail even if a param is named console");
  assert.ok(
    r.errors.some((e) => /console/i.test(e)),
    `expected console in errors, got: ${r.errors.join("; ")}`,
  );
});

test("usage of a param named console inside that function is allowed", () => {
  const src = `export function use(console: unknown) { return console; }\n`;
  const r = validateGenerated(ts, src);
  assert.equal(r.ok, true, r.errors.join("; "));
});

test("globalThis.console, globalThis.process, and window.process fail the allowlist", () => {
  const cases = [
    `export const x = globalThis.console;`,
    `export const x = globalThis.process;`,
    `export const x = window.process;`,
    `export const x = global.process;`,
  ];
  for (const src of cases) {
    const r = validateGenerated(ts, src);
    assert.equal(r.ok, false, `expected reject: ${src}`);
  }
  const cryptoOk = validateGenerated(ts, `export const c = globalThis.crypto;\n`);
  assert.equal(cryptoOk.ok, true, cryptoOk.errors.join("; "));
});

test("export-from external packages is forbidden", () => {
  const cases = [
    `export { map } from "ramda";\n`,
    `export { get } from "lodash";\n`,
    `export * from "ms";\n`,
    `export { readFile } from "node:fs";\n`,
  ];
  for (const src of cases) {
    const r = validateGenerated(ts, src);
    assert.equal(r.ok, false, `expected reject: ${src}`);
  }
});

test("OriginalSourceGuard refuses lodash/moment implementation js under node_modules", () => {
  assert.throws(
    () => OriginalSourceGuard.assertNotOriginalImpl("/app/node_modules/lodash/lodash.js"),
    /OriginalSourceGuard/,
  );
  assert.throws(
    () => OriginalSourceGuard.assertNotOriginalImpl("/app/node_modules/lodash/get.js"),
    /OriginalSourceGuard/,
  );
  assert.throws(
    () => OriginalSourceGuard.assertNotOriginalImpl("/app/node_modules/moment/moment.js"),
    /OriginalSourceGuard/,
  );
  OriginalSourceGuard.assertNotOriginalImpl("/app/node_modules/lodash/index.d.ts");
  OriginalSourceGuard.assertNotOriginalImpl("/app/node_modules/moment/README.md");
});

test("OriginalSourceGuard refuses any package implementation, maps, and tests under node_modules", () => {
  const refuse = [
    "/app/node_modules/@acme/kit/dist/index.js",
    "/app/node_modules/@acme/kit/dist/index.mjs",
    "/app/node_modules/@acme/kit/dist/index.cjs",
    "/app/node_modules/@acme/kit/index.js.map",
    "/app/node_modules/@acme/kit/dist/index.cjs.map",
    "/app/node_modules/ms/test/test.js",
    "/app/node_modules/ms/__tests__/index.js",
    "/app/node_modules/ms/foo.test.js",
  ];
  for (const p of refuse) {
    assert.throws(() => OriginalSourceGuard.assertNotOriginalImpl(p), /OriginalSourceGuard/, p);
  }
  OriginalSourceGuard.assertNotOriginalImpl("/app/node_modules/@acme/kit/index.d.ts");
  OriginalSourceGuard.assertNotOriginalImpl("/app/node_modules/ms/README.md");
  OriginalSourceGuard.assertNotOriginalImpl("/app/node_modules/ms/package.json");
  OriginalSourceGuard.assertNotOriginalImpl("/repo/src/generate/catalog/lodash.get.ts");
});

test("readPublicSpec allows only .d.ts or README", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-spec-"));
  const dts = join(dir, "index.d.ts");
  writeFileSync(dts, "export function get(): unknown;\n");
  assert.equal(OriginalSourceGuard.readPublicSpec(dts), "export function get(): unknown;\n");
  assert.throws(() => OriginalSourceGuard.readPublicSpec("/app/node_modules/lodash/lodash.js"), /OriginalSourceGuard/);
});
