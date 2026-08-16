import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProject, walkSourceFiles, filterSourceFiles } from "../src/project.ts";
import { analyzePackage, collectImportSpecifiers } from "../src/analyze/index.ts";
import { scanProject } from "../src/scan.ts";
import { lockfileDirectDeps } from "../src/scan/lockfile-deps.ts";

function linkTypescript(root: string) {
  const tsDir = dirname(createRequire(import.meta.url).resolve("typescript/package.json"));
  mkdirSync(join(root, "node_modules"), { recursive: true });
  const dest = join(root, "node_modules", "typescript");
  if (!existsSync(dest)) symlinkSync(tsDir, dest);
}

function mini(
  files: Record<string, string>,
  extraPkg: Record<string, unknown> = {},
): string {
  const root = mkdtempSync(join(tmpdir(), "slim-scan-"));
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
  for (const [p, body] of Object.entries(files)) {
    const abs = join(root, p);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  linkTypescript(root);
  return root;
}

test("filterSourceFiles ignore skips matching relative paths", () => {
  const root = "/proj";
  const files = [
    join(root, "src/app.ts"),
    join(root, "src/vendor/copy.ts"),
    join(root, "lib/other.ts"),
  ];
  const kept = filterSourceFiles(files, root, { ignore: ["vendor"] });
  assert.deepEqual(
    kept.map((f) => f.slice(root.length + 1).replace(/\\/g, "/")),
    ["src/app.ts", "lib/other.ts"],
  );
});

test("filterSourceFiles include keeps only matching relative paths", () => {
  const root = "/proj";
  const files = [join(root, "src/app.ts"), join(root, "src/vendor/copy.ts"), join(root, "lib/other.ts")];
  const kept = filterSourceFiles(files, root, { include: ["src/app"] });
  assert.deepEqual(
    kept.map((f) => f.slice(root.length + 1).replace(/\\/g, "/")),
    ["src/app.ts"],
  );
});

test("analyzePackage ignore drops call sites in ignored paths", () => {
  const root = mini({
    "src/app.ts": `import { get } from "lodash";\nexport const a = get({}, "x");\n`,
    "src/vendor/copy.ts": `import { merge } from "lodash";\nexport const b = merge({}, {});\n`,
    "slim.json": JSON.stringify({ ignore: ["vendor"] }),
  });
  const env = analyzePackage(loadProject(root), "lodash", { ignore: ["vendor"] });
  const names = env.symbols.map((s) => s.exportName).sort();
  assert.deepEqual(names, ["get"]);
});

test("analyzePackage include limits call sites to matching paths", () => {
  const root = mini({
    "src/app.ts": `import { get } from "lodash";\nexport const a = get({}, "x");\n`,
    "src/other.ts": `import { merge } from "lodash";\nexport const b = merge({}, {});\n`,
  });
  const env = analyzePackage(loadProject(root), "lodash", { include: ["src/app"] });
  const names = env.symbols.map((s) => s.exportName).sort();
  assert.deepEqual(names, ["get"]);
});

test("collectImportSpecifiers honors include", () => {
  const root = mini({
    "src/app.ts": `import { get } from "lodash";\n`,
    "src/other.ts": `import moment from "moment";\n`,
  });
  const map = collectImportSpecifiers(loadProject(root), { include: ["src/app"] });
  assert.ok(map.has("lodash"));
  assert.equal(map.has("moment"), false);
});

test("npm lockfile v3 yields exact direct versions", () => {
  const root = mini(
    {
      "package-lock.json": JSON.stringify({
        name: "mini",
        lockfileVersion: 3,
        packages: {
          "": { dependencies: { lodash: "^4.17.21" } },
          "node_modules/lodash": { version: "4.17.21" },
        },
      }),
    },
  );
  const deps = lockfileDirectDeps(root, "npm");
  assert.equal(deps.get("lodash"), "4.17.21");
});

test("scan prefers lockfile exact version over package.json range", () => {
  const root = mini(
    {
      "src/app.ts": `import { get } from "lodash";\nexport const a = get({}, "x");\n`,
      "package-lock.json": JSON.stringify({
        name: "mini",
        lockfileVersion: 3,
        packages: {
          "": { dependencies: { lodash: "^4.17.21" } },
          "node_modules/lodash": { version: "4.17.21" },
        },
      }),
    },
  );
  const report = scanProject(root);
  const row = report.rows.find((r) => r.name === "lodash");
  assert.ok(row);
  assert.equal(row!.version, "4.17.21");
});

test("scan include from slim.json hides other packages", () => {
  const root = mini({
    "src/app.ts": `import { get } from "lodash";\nexport const a = get({}, "x");\n`,
    "src/other.ts": `import moment from "moment";\nexport const b = moment();\n`,
    "slim.json": JSON.stringify({ include: ["src/app"] }),
  });
  const report = scanProject(root);
  const lodash = report.rows.find((r) => r.name === "lodash");
  const moment = report.rows.find((r) => r.name === "moment");
  assert.ok(lodash && lodash.importSites > 0);
  assert.ok(!moment || moment.importSites === 0);
});

test("pnpm lockfile reads importers . dependencies version", () => {
  const root = mini({
    "pnpm-lock.yaml": `lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      lodash:
        specifier: ^4.17.21
        version: 4.17.21

packages: {}
`,
  });
  const deps = lockfileDirectDeps(root, "pnpm");
  assert.equal(deps.get("lodash"), "4.17.21");
});

test("yarn.lock reads top-level package versions", () => {
  const root = mini({
    "yarn.lock": `# yarn lockfile v1

lodash@^4.17.21:
  version "4.17.21"
  resolved "https://registry.yarnpkg.com/lodash/-/lodash-4.17.21.tgz"
`,
  });
  const deps = lockfileDirectDeps(root, "yarn");
  assert.equal(deps.get("lodash"), "4.17.21");
});

test("walkSourceFiles still skips node_modules by directory name", () => {
  const root = mini({
    "src/app.ts": `export const a = 1;\n`,
    "node_modules/lodash/index.js": `module.exports = {};\n`,
  });
  const files = walkSourceFiles(root);
  assert.ok(files.some((f) => f.endsWith("app.ts")));
  assert.equal(
    files.some((f) => f.includes("node_modules")),
    false,
  );
});

void fileURLToPath;
