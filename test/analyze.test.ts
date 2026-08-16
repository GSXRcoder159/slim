import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, symlinkSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadProject, loadTargetTypescript } from "../src/project.ts";
import { analyzePackage, resolvePackageFamily } from "../src/analyze/index.ts";
import { parseCli } from "../src/cli.ts";
import { runInspect } from "../src/inspect.ts";

function linkTypescript(root: string) {
  const tsDir = dirname(createRequire(import.meta.url).resolve("typescript/package.json"));
  mkdirSync(join(root, "node_modules"), { recursive: true });
  const dest = join(root, "node_modules", "typescript");
  if (!existsSync(dest)) symlinkSync(tsDir, dest);
}

function mini(files: Record<string, string>, extraPkg: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "slim-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "mini",
      type: "module",
      dependencies: { lodash: "^4.17.21" },
      devDependencies: { typescript: "^5.9.0" },
      ...extraPkg,
    }),
  );
  mkdirSync(join(root, "src"), { recursive: true });
  for (const [p, body] of Object.entries(files)) {
    const abs = join(root, p);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  }
  linkTypescript(root);
  return root;
}

function analyze(files: Record<string, string>, pkg = "lodash", extraPkg?: Record<string, unknown>) {
  return analyzePackage(loadProject(mini(files, extraPkg)), pkg);
}

function writeFakePkg(
  root: string,
  name: string,
  files: Record<string, string>,
  pkgJson: Record<string, unknown> = {},
) {
  const dir = join(root, "node_modules", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name, version: "1.0.0", main: "index.js", ...pkgJson }),
  );
  for (const [p, body] of Object.entries(files)) {
    const abs = join(dir, p);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  }
}

test("family lodash.get and lodash-es collapse", () => {
  assert.equal(resolvePackageFamily("lodash-es")?.family, "lodash");
  assert.equal(resolvePackageFamily("lodash.get")?.family, "lodash");
  assert.equal(resolvePackageFamily("lodash/debounce.js")?.subpath, "debounce");
});

test("analyze named and default lodash get/debounce", () => {
  const root = mini({
    "src/app.ts": `
      import _ from "lodash";
      import { get, debounce } from "lodash-es";
      export function f(o: object) {
        return _.get(o, "a.b", 1);
      }
      export const d = debounce(() => {}, 100);
      export const g = get({ a: { b: 2 } }, "a.b");
    `,
  });
  const project = loadProject(root);
  const env = analyzePackage(project, "lodash");
  const names = env.symbols.map((s) => s.exportName).sort();
  assert.ok(names.includes("get"));
  assert.ok(names.includes("debounce"));
  const getSym = env.symbols.find((s) => s.exportName === "get");
  assert.ok((getSym?.callSites.length ?? 0) >= 2);
  const db = env.symbols.find((s) => s.exportName === "debounce");
  assert.equal(db?.callSites[0]?.argc.observed[0], 2);
});

test("arr.map(get) is binding-escape with arity 3", () => {
  const root = mini({
    "src/app.ts": `
      import { get } from "lodash";
      export const xs = [{ a: 1 }].map(get);
    `,
  });
  const env = analyzePackage(loadProject(root), "lodash");
  assert.ok(env.unknowns.some((u) => u.kind === "binding-escape"));
  const getSym = env.symbols.find((s) => s.exportName === "get");
  assert.ok(getSym?.callSites.some((c) => c.argc.max === 3));
});

test("computed member is unknown", () => {
  const root = mini({
    "src/app.ts": `
      import _ from "lodash";
      export function f(k: string) { return (_ as any)[k]({}); }
    `,
  });
  const env = analyzePackage(loadProject(root), "lodash");
  assert.ok(env.unknowns.some((u) => u.kind === "dynamic-member"));
  assert.equal(env.closure.readyToGenerate, false);
  assert.notEqual(env.closure.confidence, "closed");
});

test("allow-unknown with untraced dynamic members is not closed", () => {
  const root = mini({
    "src/app.ts": `
      import _ from "lodash";
      export function f(k: string) { return (_ as any)[k]({}); }
    `,
  });
  const env = analyzePackage(loadProject(root), "lodash", { allowUnknown: true });
  assert.notEqual(env.closure.confidence, "closed");
  assert.notEqual(env.closure.confidence, "trace-closed");
});

test("worker env tag if wrangler present", () => {
  const env = analyze(
    { "src/app.ts": `import { get } from "lodash"; get({}, "a");` },
    "lodash",
    { devDependencies: { typescript: "^5.9.0", wrangler: "^4.0.0" } },
  );
  assert.ok(env.env.includes("worker"));
  assert.ok(env.env.includes("node"));
});

test("loadTargetTypescript refuses third-party repo without typescript", () => {
  const root = mkdtempSync(join(tmpdir(), "slim-no-ts-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "other", type: "module" }));
  assert.throws(() => loadTargetTypescript(root), {
    message: "slim needs typescript to analyze this repo. npm i -D typescript",
  });
});

test("loadTargetTypescript allows slim's own tree", () => {
  const ts = loadTargetTypescript(join(import.meta.dirname, ".."));
  assert.equal(typeof ts.createSourceFile, "function");
});

test("lodash/get and lodash.get and lodash/debounce.js import styles", () => {
  const env = analyze({
    "src/app.ts": `
      import get from "lodash/get";
      import debounce from "lodash/debounce.js";
      import lodashGet from "lodash.get";
      export const a = get({ a: 1 }, "a");
      export const b = debounce(() => {}, 10);
      export const c = lodashGet({ a: 1 }, "a");
    `,
  });
  const names = env.symbols.map((s) => s.exportName).sort();
  assert.ok(names.includes("get"));
  assert.ok(names.includes("debounce"));
  const getSym = env.symbols.find((s) => s.exportName === "get");
  assert.ok((getSym?.callSites.length ?? 0) >= 2);
});

test("ESM namespace import * as _", () => {
  const env = analyze({
    "src/app.ts": `
      import * as _ from "lodash";
      export const v = _.get({ a: 1 }, "a");
    `,
  });
  assert.ok(env.symbols.some((s) => s.exportName === "get"));
  assert.ok(env.imports.some((i) => i.kind === "namespace"));
});

test("CJS require and destructure", () => {
  const env = analyze({
    "src/cjs.cjs": `
      const _ = require("lodash");
      const { get } = require("lodash");
      module.exports = { a: _.get({ a: 1 }, "a"), b: get({ a: 1 }, "a") };
    `,
  });
  const getSym = env.symbols.find((s) => s.exportName === "get");
  assert.ok((getSym?.callSites.length ?? 0) >= 2);
  assert.ok(env.imports.some((i) => i.kind === "cjs-require"));
});

test("static import('lodash') is walked; dynamic import(x) is unknown", () => {
  const env = analyze({
    "src/app.ts": `
      export async function f(o: object, x: string) {
        const m = await import("lodash");
        m.get(o, "a");
        return import(x);
      }
    `,
  });
  assert.ok(env.symbols.some((s) => s.exportName === "get"));
  assert.ok(env.unknowns.some((u) => u.kind === "dynamic-specifier"));
});

test("local re-export export { get } from lodash-es and export * from lodash", () => {
  const env = analyze({
    "src/named-barrel.ts": `export { get } from "lodash-es";`,
    "src/star-barrel.ts": `export * from "lodash";`,
    "src/app.ts": `
      import { get } from "./named-barrel";
      import { debounce } from "./star-barrel";
      export const a = get({ a: 1 }, "a");
      export const d = debounce(() => {}, 5);
    `,
  });
  const names = env.symbols.map((s) => s.exportName).sort();
  assert.ok(names.includes("get"));
  assert.ok(names.includes("debounce"));
});

test("d.cancel() and d.flush() record result members on symbol and call site", () => {
  const env = analyze({
    "src/app.ts": `
      import { debounce } from "lodash";
      const d = debounce(() => {}, 100);
      d.cancel();
      d.flush();
    `,
  });
  const db = env.symbols.find((s) => s.exportName === "debounce");
  assert.ok(db);
  assert.ok(db!.resultMembers.includes("cancel"));
  assert.ok(db!.resultMembers.includes("flush"));
  assert.ok(db!.callSites.some((c) => c.resultMembers.includes("cancel") && c.resultMembers.includes("flush")));
});

test("spread-args emits UnknownSite and argc.max is null", () => {
  const env = analyze({
    "src/app.ts": `
      import { get } from "lodash";
      const args: [object, string] = [{ a: 1 }, "a"];
      export const v = get(...args);
    `,
  });
  assert.ok(env.unknowns.some((u) => u.kind === "spread-args"));
  const getSym = env.symbols.find((s) => s.exportName === "get");
  assert.ok(getSym);
  assert.equal(getSym!.callSites[0]?.argc.max, null);
  assert.equal(getSym!.callSites[0]?.spread, true);
});

test("ts-any on an argument emits unknown and keeps the symbol", () => {
  const env = analyze({
    "src/app.ts": `
      import { get } from "lodash";
      export function f(o: object) {
        return get(o as any, "a");
      }
    `,
  });
  assert.ok(env.unknowns.some((u) => u.kind === "ts-any"));
  assert.ok(env.symbols.some((s) => s.exportName === "get"));
});

test("ts-any on : any parameter even without paths/unions", () => {
  const env = analyze({
    "src/app.ts": `
      import { get } from "lodash";
      export function f(o: any) {
        return get(o, "a");
      }
    `,
  });
  assert.ok(env.unknowns.some((u) => u.kind === "ts-any"));
  assert.ok(env.symbols.some((s) => s.exportName === "get"));
});

test("ts-any unwraps parentheses around any-typed args", () => {
  const env = analyze({
    "src/app.ts": `
      import { get } from "lodash";
      export function f(o: any) {
        return get((o), "a") + get((o as any), "b");
      }
    `,
  });
  assert.ok(env.unknowns.filter((u) => u.kind === "ts-any").length >= 2);
  assert.ok(env.symbols.some((s) => s.exportName === "get"));
});

test("inner d.cancel() does not attach to an outer same-named debounce", () => {
  const env = analyze({
    "src/app.ts": `
      import { debounce } from "lodash";
      export function outer() {
        const d = debounce(() => {}, 10);
        {
          const d = debounce(() => {}, 20);
          d.cancel();
        }
        d.flush();
      }
    `,
  });
  const db = env.symbols.find((s) => s.exportName === "debounce");
  assert.ok(db);
  const outer = db!.callSites.find((c) => c.argShapes[1]?.literals?.[0] === 10);
  const inner = db!.callSites.find((c) => c.argShapes[1]?.literals?.[0] === 20);
  assert.ok(outer);
  assert.ok(inner);
  assert.equal(outer!.resultMembers.includes("cancel"), false);
  assert.ok(outer!.resultMembers.includes("flush"));
  assert.ok(inner!.resultMembers.includes("cancel"));
  assert.equal(inner!.resultMembers.includes("flush"), false);
});

test("dynamic import(x) is unknown even with no static bindings", () => {
  const env = analyze({
    "src/only-dyn.ts": `
      export async function f(x: string) {
        return import(x);
      }
    `,
  });
  assert.ok(env.unknowns.some((u) => u.kind === "dynamic-specifier"));
});

test("paths-alias Program escalation resolves get", () => {
  const root = mini({
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        baseUrl: ".",
        paths: { "@alias/lodash": ["src/lodash-alias.ts"] },
      },
    }),
    "src/lodash-alias.ts": `export { get } from "lodash";`,
    "src/app.ts": `
      import { get } from "@alias/lodash";
      export const v = get({ a: 1 }, "a");
    `,
  });
  const env = analyzePackage(loadProject(root), "lodash");
  assert.ok(env.symbols.some((s) => s.exportName === "get"));
});

test("literal-union argument uses checker literals", () => {
  const env = analyze({
    "src/app.ts": `
      import { get } from "lodash";
      export function f(o: object, p: "a.b" | "c.d") {
        return get(o, p);
      }
    `,
  });
  const getSym = env.symbols.find((s) => s.exportName === "get");
  const pathShape = getSym?.callSites[0]?.argShapes[1];
  assert.ok(pathShape);
  const lits = (pathShape!.literals ?? []).map(String).sort();
  assert.deepEqual(lits, ["a.b", "c.d"]);
});

test("closed static envelope reason includes no-traces phrase", () => {
  const env = analyze({
    "src/app.ts": `import { get } from "lodash"; export const v = get({ a: 1 }, "a");`,
  });
  assert.equal(env.closure.confidence, "closed");
  assert.match(
    env.closure.reason,
    /no traces — generators are static-shape plus catalog mutations, not your runtime distribution/,
  );
});

test("loc.file paths are relative to the project root", () => {
  const root = mini({
    "src/app.ts": `import { get } from "lodash"; export const v = get({ a: 1 }, "a");`,
  });
  const env = analyzePackage(loadProject(root), "lodash");
  const files = [
    ...env.imports.map((i) => i.loc.file),
    ...env.symbols.flatMap((s) => s.callSites.map((c) => c.loc.file)),
  ];
  assert.ok(files.length > 0, "expected import and call-site locs");
  for (const file of files) {
    assert.equal(file.startsWith("/"), false, `absolute loc.file: ${file}`);
    assert.equal(file.includes(root), false, `loc.file contains tmp root: ${file}`);
    assert.doesNotMatch(file, /\\/, `non-posix loc.file: ${file}`);
  }
});

test("inspect writes envelope under package.name not family", async () => {
  const root = mini({
    "src/app.ts": `import { get } from "lodash-es"; export const v = get({ a: 1 }, "a");`,
  });
  const cwd = process.cwd();
  process.chdir(root);
  try {
    await runInspect(parseCli(["inspect", "lodash-es", "--json"]));
    assert.ok(existsSync(join(root, ".slim", "lodash-es", "envelope.json")));
    assert.equal(existsSync(join(root, ".slim", "lodash", "envelope.json")), false);
    const saved = JSON.parse(readFileSync(join(root, ".slim", "lodash-es", "envelope.json"), "utf8")) as {
      traces?: unknown[];
      imports: Array<{ loc: { file: string } }>;
    };
    assert.deepEqual(saved.traces, []);
    for (const imp of saved.imports) {
      assert.equal(imp.loc.file.startsWith("/"), false, imp.loc.file);
      assert.equal(imp.loc.file.includes(root), false, imp.loc.file);
    }
  } finally {
    process.chdir(cwd);
  }
});

test("used-graph purity +40 only when installed slice has no fs/net/eval", () => {
  const root = mini({
    "src/app.ts": `import { get } from "purelib"; export const v = get({ a: 1 }, "a");`,
  });
  writeFakePkg(root, "purelib", {
    "index.js": `module.exports = { get: require("./get") };`,
    "get.js": `module.exports = function get(o, p) { return o == null ? undefined : o[p]; };`,
  });
  const env = analyzePackage(loadProject(root), "purelib");
  assert.ok(env.slimmable.reasons.some((r) => /used import graph/i.test(r) || /used-graph/i.test(r) || /no eval/i.test(r) || /pure/i.test(r)));
  assert.ok(env.slimmable.score >= 40);
});

test("used-graph impurity: fs in require graph denies +40", () => {
  const root = mini({
    "src/app.ts": `import { get } from "impurelib"; export const v = get({ a: 1 }, "a");`,
  });
  writeFakePkg(root, "impurelib", {
    "index.js": `module.exports = { get: require("./get") };`,
    "get.js": `const fs = require("fs"); module.exports = function get(o, p) { return fs.existsSync(p) ? o : o[p]; };`,
  });
  const env = analyzePackage(loadProject(root), "impurelib");
  assert.ok(!env.slimmable.reasons.some((r) => /used import graph has no/i.test(r) || /used-graph pure/i.test(r)));
  assert.ok(env.slimmable.score < 40 || !env.slimmable.reasons.some((r) => /\+40|pure/i.test(r)));
  assert.ok(env.slimmable.score < 70);
});

test("debounce Date.now is a seam, not a used-graph refuse", () => {
  const root = mini({
    "src/app.ts": `import { debounce } from "clocklib"; export const d = debounce(() => {}, 10);`,
  });
  writeFakePkg(root, "clocklib", {
    "index.js": `module.exports = { debounce: require("./debounce") };`,
    "debounce.js": `
      function debounce(fn, wait) {
        let t;
        const now = Date.now;
        return function() { t = now(); return fn(); };
      }
      module.exports = debounce;
    `,
  });
  const env = analyzePackage(loadProject(root), "clocklib");
  assert.equal(env.slimmable.verdict === "refuse", false);
  assert.ok(env.slimmable.score >= 40);
});
