import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProject } from "../src/project.ts";
import { analyzePackage, resolvePackageFamily } from "../src/analyze/index.ts";

function mini(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "slim-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "mini",
      type: "module",
      dependencies: { lodash: "^4.17.21" },
      devDependencies: { typescript: "^5.9.0" },
    }),
  );
  mkdirSync(join(root, "src"), { recursive: true });
  for (const [p, body] of Object.entries(files)) {
    const abs = join(root, p);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
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
});
