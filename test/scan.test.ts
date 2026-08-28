import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProject, walkSourceFiles, filterSourceFiles } from "../src/project.ts";
import { analyzePackage, collectImportSpecifiers, parseSpecifier } from "../src/analyze/index.ts";
import { formatScanHuman, scanProject, scanReportJson } from "../src/scan.ts";
import { lockfileDirectDeps } from "../src/scan/lockfile-deps.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

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
  assert.equal(deps.state, "ok");
  assert.equal(deps.versions.get("lodash"), "4.17.21");
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
  assert.equal(deps.state, "ok");
  assert.equal(deps.versions.get("lodash"), "4.17.21");
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
  assert.equal(deps.state, "ok");
  assert.equal(deps.versions.get("lodash"), "4.17.21");
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

test("parseSpecifier rejects relative, absolute, URL, protocol, and Node builtins", () => {
  assert.equal(parseSpecifier("./foo"), null);
  assert.equal(parseSpecifier("../bar"), null);
  assert.equal(parseSpecifier("/abs/pkg"), null);
  assert.equal(parseSpecifier("C:/windows/path"), null);
  assert.equal(parseSpecifier("https://example.com/pkg"), null);
  assert.equal(parseSpecifier("http://example.com/pkg"), null);
  assert.equal(parseSpecifier("file:../lib"), null);
  assert.equal(parseSpecifier("node:fs"), null);
  assert.equal(parseSpecifier("bun:sqlite"), null);
  assert.equal(parseSpecifier("npm:lodash"), null);
  assert.equal(parseSpecifier("fs"), null);
  assert.equal(parseSpecifier("path"), null);
  assert.equal(parseSpecifier("fs/promises"), null);
  assert.equal(parseSpecifier("#local"), null);
  assert.ok(isBuiltin("fs"));
});

test("parseSpecifier keeps scoped packages and subpaths", () => {
  assert.deepEqual(parseSpecifier("@scope/pkg/subpath"), {
    name: "@scope/pkg",
    subpath: "subpath",
  });
  assert.deepEqual(parseSpecifier("lodash/get"), { name: "lodash", subpath: "get" });
  assert.deepEqual(parseSpecifier("lodash.get"), { name: "lodash.get", subpath: "" });
});

test("scan omits relative, absolute, URL, and builtin import rows", () => {
  const root = mini({
    "src/app.ts": `
      import { join } from "node:path";
      import fs from "fs";
      import rel from "./util.ts";
      import abs from "/usr/lib/foo";
      import remote from "https://example.com/pkg";
      import { get } from "lodash";
      export const a = get({}, "x") + join("a", "b") + fs + rel + abs + remote;
    `,
    "src/util.ts": `export default 1;\n`,
  });
  const report = scanProject(root);
  const names = report.rows.map((r) => r.name);
  for (const n of names) {
    assert.equal(n.startsWith("."), false, n);
    assert.equal(n.startsWith("/"), false, n);
    assert.equal(n.startsWith("node:"), false, n);
    assert.equal(n.includes("://"), false, n);
    assert.equal(isBuiltin(n), false, n);
  }
  assert.ok(report.rows.some((r) => r.name === "lodash"));
});

test("scan maps package.json #imports alias to the external package", () => {
  const root = mini(
    {
      "src/app.ts": `import { get } from "#lodash";\nexport const a = get({}, "x");\n`,
    },
    {
      dependencies: { lodash: "^4.17.21" },
      imports: { "#lodash": "lodash" },
    },
  );
  const map = collectImportSpecifiers(loadProject(root));
  assert.ok(map.has("lodash"));
  assert.equal(map.has("#lodash"), false);
  const report = scanProject(root);
  const lodash = report.rows.find((r) => r.name === "lodash");
  assert.ok(lodash && lodash.importSites > 0);
});

test("scan skips #imports that resolve to a relative path", () => {
  const root = mini(
    {
      "src/app.ts": `import local from "#util";\nexport default local;\n`,
      "src/util.ts": `export default 1;\n`,
    },
    {
      dependencies: { lodash: "^4.17.21" },
      imports: { "#util": "./src/util.ts" },
    },
  );
  const report = scanProject(root);
  assert.equal(
    report.rows.some((r) => r.name === "#util" || r.name.includes("util.ts")),
    false,
  );
});

test("scan excludes file: workspace packages from third-party rows", () => {
  const root = mini(
    {
      "src/app.ts": `import x from "local-lib";\nimport { get } from "lodash";\nexport const a = get(x, "y");\n`,
    },
    {
      dependencies: { lodash: "^4.17.21", "local-lib": "file:../local-lib" },
    },
  );
  const report = scanProject(root);
  assert.equal(
    report.rows.some((r) => r.name === "local-lib"),
    false,
  );
  assert.ok(report.rows.some((r) => r.name === "lodash"));
});

test("scan reports @scope/pkg/subpath as package plus retained subpath and lockfile version", () => {
  const root = mini(
    {
      "src/app.ts": `import fn from "@scope/pkg/subpath";\nexport const a = fn();\n`,
      "package-lock.json": JSON.stringify({
        name: "mini",
        lockfileVersion: 3,
        packages: {
          "": { dependencies: { "@scope/pkg": "^2.0.0" } },
          "node_modules/@scope/pkg": { version: "2.3.4" },
        },
      }),
    },
    { dependencies: { "@scope/pkg": "^2.0.0" } },
  );
  const report = scanProject(root);
  const row = report.rows.find((r) => r.name === "@scope/pkg");
  assert.ok(row);
  assert.equal(row!.version, "2.3.4");
  assert.equal(row!.versionState, "exact");
  assert.deepEqual(row!.subpaths, ["subpath"]);
});

test("lodash family accounting keeps siblings distinct without zero-site duplicates", () => {
  const root = mini(
    {
      "src/app.ts": `
        import { get } from "lodash/get";
        import debounce from "lodash.debounce";
        import { map } from "lodash-es";
        export const a = get({}, "x");
        export const d = debounce(() => {}, 1);
        export const m = map([], (x) => x);
      `,
    },
    {
      dependencies: {
        lodash: "^4.17.21",
        "lodash-es": "^4.17.21",
        "lodash.debounce": "^4.0.8",
        leftover: "^1.0.0",
      },
    },
  );
  const report = scanProject(root);
  const lodash = report.rows.find((r) => r.name === "lodash");
  const es = report.rows.find((r) => r.name === "lodash-es");
  const perMethod = report.rows.find((r) => r.name === "lodash.debounce");
  const leftover = report.rows.find((r) => r.name === "leftover");
  assert.ok(lodash && es && perMethod && leftover);
  assert.equal(lodash!.family, "lodash");
  assert.equal(es!.family, "lodash");
  assert.equal(perMethod!.family, "lodash");
  assert.ok(lodash!.subpaths.includes("get"));
  assert.deepEqual(perMethod!.subpaths, ["debounce"]);
  assert.ok(lodash!.importSites > 0);
  assert.ok(es!.importSites > 0);
  assert.ok(perMethod!.importSites > 0);
  assert.equal(leftover!.importSites, 0);
  assert.equal(leftover!.relation, "declared-unused");
  assert.equal(es!.importSites === lodash!.importSites && es!.name === lodash!.name, false);
});

test("npm lockfile v1 yields exact top-level versions", () => {
  const root = mini({
    "package-lock.json": JSON.stringify({
      name: "mini",
      lockfileVersion: 1,
      dependencies: {
        lodash: { version: "4.17.21", dependencies: { "lodash-es": { version: "4.0.0" } } },
      },
    }),
  });
  const deps = lockfileDirectDeps(root, "npm");
  assert.equal(deps.state, "ok");
  assert.equal(deps.versions.get("lodash"), "4.17.21");
  assert.equal(deps.versions.has("lodash-es"), false);
});

test("yarn.lock keeps scoped package names", () => {
  const root = mini({
    "yarn.lock": `# yarn lockfile v1

"@scope/pkg@^2.0.0":
  version "2.3.4"
  resolved "https://registry.yarnpkg.com/@scope/pkg/-/pkg-2.3.4.tgz"

vue@^3.0.0:
  version "3.5.0"
`,
  });
  const deps = lockfileDirectDeps(root, "yarn");
  assert.equal(deps.versions.get("@scope/pkg"), "2.3.4");
  assert.equal(deps.versions.get("vue"), "3.5.0");
});

test("yarn berry lockfile reads npm: protocol versions", () => {
  const root = mini({
    "yarn.lock": `# This file is generated by running "yarn install" inside your project.

__metadata:
  version: 6

"lodash@npm:^4.17.21":
  version: 4.17.21
  resolution: "lodash@npm:4.17.21"

"@scope/pkg@npm:^2.0.0":
  version: 2.3.4
  resolution: "@scope/pkg@npm:2.3.4"
`,
  });
  const deps = lockfileDirectDeps(root, "yarn");
  assert.equal(deps.state, "ok");
  assert.equal(deps.versions.get("lodash"), "4.17.21");
  assert.equal(deps.versions.get("@scope/pkg"), "2.3.4");
});

test("bun.lock text yields exact direct versions", () => {
  const root = mini({
    "bun.lock": `{
  "lockfileVersion": 1,
  "workspaces": {
    "": {
      "dependencies": {
        "lodash": "^4.17.21",
        "@scope/pkg": "^2.0.0"
      }
    }
  },
  "packages": {
    "lodash": ["lodash@4.17.21", "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz", {}, "sha512-aa"],
    "@scope/pkg": ["@scope/pkg@2.3.4", "https://registry.npmjs.org/@scope/pkg/-/pkg-2.3.4.tgz", {}, "sha512-bb"]
  }
}
`,
  });
  const deps = lockfileDirectDeps(root, "bun");
  assert.equal(deps.state, "ok");
  assert.equal(deps.versions.get("lodash"), "4.17.21");
  assert.equal(deps.versions.get("@scope/pkg"), "2.3.4");
});

test("bun.lock with comments still parses", () => {
  const root = mini({
    "bun.lock": `// bun lockfile
{
  "lockfileVersion": 1,
  "packages": {
    "lodash": ["lodash@4.17.21"]
  }
}
`,
  });
  const deps = lockfileDirectDeps(root, "bun");
  assert.equal(deps.state, "ok");
  assert.equal(deps.versions.get("lodash"), "4.17.21");
});

test("binary bun.lockb is unavailable with a reason", () => {
  const root = mini({
    "bun.lockb": Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]).toString("latin1"),
  });
  writeFileSync(join(root, "bun.lockb"), Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]));
  const deps = lockfileDirectDeps(root, "bun");
  assert.equal(deps.state, "unavailable");
  assert.match(deps.reason, /bun\.lockb|binary|text bun\.lock/i);
  assert.equal(deps.versions.size, 0);
});

test("malformed npm lockfile reports unknown with reason, not a stripped range", () => {
  const root = mini(
    {
      "src/app.ts": `import { get } from "lodash";\nexport const a = get({}, "x");\n`,
      "package-lock.json": "{ this is not json",
    },
  );
  const deps = lockfileDirectDeps(root, "npm");
  assert.equal(deps.state, "malformed");
  const report = scanProject(root);
  const row = report.rows.find((r) => r.name === "lodash");
  assert.ok(row);
  assert.equal(row!.version, "unknown");
  assert.equal(row!.versionState, "malformed");
  assert.ok(row!.versionReason.length > 0);
  assert.equal(row!.version.includes("4.17.21"), false);
});

test("no lockfile keeps package.json range as range-only unknown", () => {
  const root = mini({
    "src/app.ts": `import { get } from "lodash";\nexport const a = get({}, "x");\n`,
  });
  const report = scanProject(root);
  const row = report.rows.find((r) => r.name === "lodash");
  assert.ok(row);
  assert.equal(row!.version, "unknown");
  assert.equal(row!.versionState, "range-only");
  assert.match(row!.versionReason, /\^4\.17\.21|range/i);
});

test("declared-unused and imported-undeclared are distinct in JSON and human output", () => {
  const root = mini(
    {
      "src/app.ts": `import ghost from "ghost-pkg";\nexport default ghost;\n`,
    },
    {
      dependencies: { leftover: "^1.0.0" },
      optionalDependencies: { "opt-pkg": "^2.0.0" },
    },
  );
  const report = scanProject(root);
  const leftover = report.rows.find((r) => r.name === "leftover");
  const ghost = report.rows.find((r) => r.name === "ghost-pkg");
  const opt = report.rows.find((r) => r.name === "opt-pkg");
  assert.ok(leftover && ghost && opt);
  assert.equal(leftover!.relation, "declared-unused");
  assert.equal(leftover!.verdict, "unused");
  assert.equal(leftover!.declaredAs, "dependency");
  assert.equal(ghost!.relation, "imported-undeclared");
  assert.equal(ghost!.declaredAs, "none");
  assert.equal(opt!.declaredAs, "optional");
  assert.equal(opt!.relation, "declared-unused");
  const human = formatScanHuman(report);
  assert.match(human, /leftover/);
  assert.match(human, /ghost-pkg/);
  assert.match(human, /declared-unused|unused/);
  assert.match(human, /imported-undeclared|undeclared/);
  assert.doesNotMatch(human, /slimmable/i);
});

test("scan never awards slim from size and few import sites", () => {
  const root = mini({
    "src/app.ts": `import { get } from "lodash";\nexport const a = get({}, "x");\n`,
  });
  const report = scanProject(root);
  const row = report.rows.find((r) => r.name === "lodash");
  assert.ok(row);
  assert.notEqual(row!.verdict, "slim");
  assert.ok(row!.verdict === "candidate" || row!.verdict === "review");
  assert.equal(
    report.rows.some((r) => r.verdict === "slim"),
    false,
  );
});

test("scan ignore from slim.json drops sites in ignored paths", () => {
  const root = mini({
    "src/app.ts": `import { get } from "lodash";\nexport const a = get({}, "x");\n`,
    "src/vendor/copy.ts": `import moment from "moment";\nexport const b = moment();\n`,
    "slim.json": JSON.stringify({ ignore: ["vendor"] }),
  });
  const report = scanProject(root);
  const lodash = report.rows.find((r) => r.name === "lodash");
  const moment = report.rows.find((r) => r.name === "moment");
  assert.ok(lodash && lodash.importSites > 0);
  assert.ok(!moment || moment.importSites === 0);
});

test("scan JSON has no absolute root and is byte-identical across runs", () => {
  const root = mini({
    "src/app.ts": `import { get } from "lodash";\nexport const a = get({}, "x");\n`,
  });
  const a = scanReportJson(scanProject(root));
  const b = scanReportJson(scanProject(root));
  assert.equal(a, b);
  const doc = JSON.parse(a) as { root?: unknown; rows: unknown };
  assert.equal("root" in doc, false);
  assert.equal(a.includes(root), false);
});

test("scan --json emits one schema-valid document and no progress on stdout", () => {
  const root = mini({
    "src/app.ts": `import { get } from "lodash";\nexport const a = get({}, "x");\n`,
  });
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", join(ROOT, "src/main.ts"), "scan", "--json", root],
    { encoding: "utf8", timeout: 30_000, env: { ...process.env, CI: "1" } },
  );
  assert.equal(r.status, 0, r.stderr);
  const stdout = r.stdout ?? "";
  assert.equal(stdout.trimStart().startsWith("{"), true, stdout);
  const doc = JSON.parse(stdout) as unknown;
  const pretty = JSON.stringify(doc, null, 2) + "\n";
  const compact = JSON.stringify(doc) + "\n";
  assert.ok(stdout === pretty || stdout === compact, "stdout is not exactly one JSON document");
  const schema = JSON.parse(readFileSync(join(ROOT, "docs/scan.schema.json"), "utf8")) as {
    required: string[];
    properties: Record<string, unknown>;
  };
  assert.ok(schema.required.includes("schemaVersion"));
  assert.ok(schema.required.includes("rows"));
  const rec = doc as Record<string, unknown>;
  for (const key of schema.required) {
    assert.ok(key in rec, `missing ${key}`);
  }
});

test("scanning this repository emits zero relative, absolute, or builtin rows", () => {
  const report = scanProject(ROOT);
  for (const row of report.rows) {
    assert.equal(row.name.startsWith("."), false, row.name);
    assert.equal(row.name.startsWith("/"), false, row.name);
    assert.equal(row.name.startsWith("node:"), false, row.name);
    assert.equal(isBuiltin(row.name), false, row.name);
    assert.equal(/^[a-zA-Z]:[\\/]/.test(row.name), false, row.name);
  }
});

test("import type is not a runtime import site; declared package is unused", () => {
  const root = mini({
    "src/app.ts": `import type { Dictionary } from "lodash";\nexport type T = Dictionary<string>;\n`,
  });
  const map = collectImportSpecifiers(loadProject(root));
  assert.equal(map.has("lodash"), false);
  const report = scanProject(root);
  const row = report.rows.find((r) => r.name === "lodash");
  assert.ok(row);
  assert.equal(row!.importSites, 0);
  assert.equal(row!.typeOnlySites, 1);
  assert.equal(row!.relation, "declared-unused");
  assert.equal(row!.verdict, "unused");
  assert.match(row!.note, /type-only/);
  const human = formatScanHuman(report);
  assert.match(human, /type-only/);
  assert.match(human, /estimated|measured|unknown|partial/);
});

test("undeclared type-only package has no scan row", () => {
  const root = mini({
    "src/app.ts": `import type { Foo } from "ghost-types";\nexport type T = Foo;\n`,
  });
  const report = scanProject(root);
  assert.equal(
    report.rows.some((r) => r.name === "ghost-types"),
    false,
  );
});

test("mixed type and runtime named imports keep only the runtime portion", () => {
  const root = mini({
    "src/app.ts": `import { type Dictionary, get } from "lodash";\nexport const a = get({}, "x");\nexport type T = Dictionary<string>;\n`,
  });
  const map = collectImportSpecifiers(loadProject(root));
  const sites = map.get("lodash") ?? [];
  assert.equal(sites.length, 1);
  assert.deepEqual(sites[0]!.names, ["get"]);
  const report = scanProject(root);
  const row = report.rows.find((r) => r.name === "lodash");
  assert.ok(row);
  assert.equal(row!.importSites, 1);
  assert.equal(row!.typeOnlySites, 1);
  assert.equal(row!.relation, "declared-imported");
  assert.notEqual(row!.verdict, "unused");
  const human = formatScanHuman(report);
  assert.match(human, /types/);
  assert.ok(human.split("\n").some((line) => line.includes("lodash") && /\b1\b/.test(line)));
});

test("export type from a package is not a runtime site", () => {
  const root = mini({
    "src/app.ts": `export type { Dictionary } from "lodash";\n`,
  });
  const map = collectImportSpecifiers(loadProject(root));
  assert.equal(map.has("lodash"), false);
  const report = scanProject(root);
  const row = report.rows.find((r) => r.name === "lodash");
  assert.ok(row);
  assert.equal(row!.importSites, 0);
  assert.ok(row!.typeOnlySites >= 1);
  assert.equal(row!.verdict, "unused");
});

test("mixed export { type X, y } keeps only the runtime export", () => {
  const root = mini({
    "src/app.ts": `export { type Dictionary, get } from "lodash";\n`,
  });
  const map = collectImportSpecifiers(loadProject(root));
  const sites = map.get("lodash") ?? [];
  assert.equal(sites.length, 1);
  assert.deepEqual(sites[0]!.names, ["get"]);
});

test("import type namespace is not a runtime site", () => {
  const root = mini({
    "src/app.ts": `import type * as _ from "lodash";\nexport type T = _.Dictionary<string>;\n`,
  });
  assert.equal(collectImportSpecifiers(loadProject(root)).has("lodash"), false);
});

test("typeof import() type query is not a runtime site", () => {
  const root = mini({
    "src/app.ts": `export type T = import("lodash").Dictionary<string>;\n`,
  });
  assert.equal(collectImportSpecifiers(loadProject(root)).has("lodash"), false);
  const report = scanProject(root);
  const row = report.rows.find((r) => r.name === "lodash");
  assert.ok(row);
  assert.equal(row!.importSites, 0);
  assert.equal(row!.verdict, "unused");
});

test("import equals require is a runtime CJS site; import type equals is not", () => {
  const runtime = mini({
    "src/app.ts": `import lodash = require("lodash");\nexport const a = lodash.get({}, "x");\n`,
  });
  const runtimeSites = collectImportSpecifiers(loadProject(runtime)).get("lodash") ?? [];
  assert.equal(runtimeSites.length, 1);
  assert.equal(runtimeSites[0]!.kind, "cjs-require");

  const typeOnly = mini({
    "src/app.ts": `import type lodash = require("lodash");\nexport type T = typeof lodash;\n`,
  });
  assert.equal(collectImportSpecifiers(loadProject(typeOnly)).has("lodash"), false);
});

test("CJS require remains a runtime import site", () => {
  const root = mini({
    "src/app.ts": `const lodash = require("lodash");\nexport const a = lodash.get({}, "x");\n`,
  });
  const sites = collectImportSpecifiers(loadProject(root)).get("lodash") ?? [];
  assert.equal(sites.length, 1);
  assert.equal(sites[0]!.kind, "cjs-require");
});

test("scan JSON schemaVersion is 2 and rows include typeOnlySites", () => {
  const root = mini({
    "src/app.ts": `import { get } from "lodash";\nexport const a = get({}, "x");\n`,
  });
  const report = scanProject(root);
  assert.equal(report.schemaVersion, 2);
  const row = report.rows.find((r) => r.name === "lodash");
  assert.ok(row);
  assert.equal(typeof row!.typeOnlySites, "number");
  const human = formatScanHuman(report);
  assert.match(human, /estimated|measured|unknown|partial/);
});

test("scan --json on a project without TypeScript emits one error document", () => {
  const root = mkdtempSync(join(tmpdir(), "slim-scan-nots-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "nots", type: "module" }));
  writeFileSync(join(root, "src.ts"), `export const n = 1;\n`);
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", join(ROOT, "src/main.ts"), "scan", "--json", root],
    { encoding: "utf8", timeout: 30_000, env: { ...process.env, CI: "1" } },
  );
  assert.notEqual(r.status, 0);
  const stdout = r.stdout ?? "";
  assert.equal(stdout.trimStart().startsWith("{"), true, stdout);
  const doc = JSON.parse(stdout) as { ok?: boolean; schemaVersion?: number; error?: string };
  assert.equal(doc.ok, false);
  assert.equal(doc.schemaVersion, 1);
  assert.equal(typeof doc.error, "string");
  assert.equal(stdout.trim().split("\n").filter((l) => l.startsWith("{") || l.startsWith("}")).length >= 1, true);
});

test("scan reports partial provenance when the installed tree is unreadable", () => {
  const root = mini(
    { "src/app.ts": `import x from "tiny-lib";\nexport const a = x;\n` },
    { dependencies: { "tiny-lib": "^1.0.0" } },
  );
  const nm = join(root, "node_modules", "tiny-lib");
  mkdirSync(nm, { recursive: true });
  writeFileSync(join(nm, "package.json"), JSON.stringify({ name: "tiny-lib", version: "1.0.0" }));
  writeFileSync(join(nm, "index.js"), "export default 1;\n");
  symlinkSync(join(nm, "missing-target"), join(nm, "broken"));
  const report = scanProject(root);
  const row = report.rows.find((r) => r.name === "tiny-lib");
  assert.ok(row);
  assert.equal(row!.sizeProvenance, "partial");
  assert.equal(row!.sizeState, "review");
  assert.match(formatScanHuman(report), /partial/);
});

test("scan reports partial not estimated for a known-size package with a broken install link", () => {
  const root = mini({
    "src/app.ts": `import { get } from "lodash";\nexport const a = get({}, "x");\n`,
  });
  const nm = join(root, "node_modules", "lodash");
  mkdirSync(nm, { recursive: true });
  writeFileSync(join(nm, "package.json"), JSON.stringify({ name: "lodash", version: "4.17.21" }));
  writeFileSync(join(nm, "index.js"), "module.exports = {};\n");
  symlinkSync(join(nm, "missing-target"), join(nm, "broken"));
  const report = scanProject(root);
  const row = report.rows.find((r) => r.name === "lodash");
  assert.ok(row);
  assert.equal(row!.sizeProvenance, "partial");
  assert.equal(row!.sizeState, "review");
  assert.equal(row!.minBytes, 71_000);
  assert.equal(row!.verdict, "candidate");
  assert.match(row!.note, /symlink|unreadable/i);
  const json = scanReportJson(report);
  assert.ok(json.startsWith("{"));
  const human = formatScanHuman(report);
  const lodashLine = human.split("\n").find((line) => /^\s*lodash\b/.test(line) || line.startsWith("lodash"));
  assert.ok(lodashLine);
  assert.match(lodashLine!, /partial/);
  assert.doesNotMatch(lodashLine!, /estimated/);
});

test("scan reports unknown not estimated for a known-size package with no install", () => {
  const root = mini({
    "src/app.ts": `import { get } from "lodash";\nexport const a = get({}, "x");\n`,
  });
  const report = scanProject(root);
  const row = report.rows.find((r) => r.name === "lodash");
  assert.ok(row);
  assert.equal(row!.sizeProvenance, "unknown");
  assert.equal(row!.sizeState, "unknown");
  assert.equal(row!.minBytes, 71_000);
  assert.equal(row!.verdict, "candidate");
  assert.match(row!.note, /not installed/i);
  scanReportJson(report);
});

test("scan sizeState does not copy ranking review over a complete measurement", () => {
  const imports = Array.from(
    { length: 12 },
    (_, i) => `import x${i} from "tiny-lib";\nexport const a${i} = x${i};\n`,
  ).join("");
  const root = mini(
    { "src/app.ts": imports },
    { dependencies: { "tiny-lib": "^1.0.0" } },
  );
  const nm = join(root, "node_modules", "tiny-lib");
  mkdirSync(nm, { recursive: true });
  writeFileSync(join(nm, "package.json"), JSON.stringify({ name: "tiny-lib", version: "1.0.0" }));
  writeFileSync(join(nm, "index.js"), "export default 1;\n");
  const report = scanProject(root);
  const row = report.rows.find((r) => r.name === "tiny-lib");
  assert.ok(row);
  assert.ok(row!.importSites > 8);
  assert.equal(row!.verdict, "review");
  assert.equal(row!.sizeProvenance, "measured");
  assert.equal(row!.sizeState, "measured");
});

void fileURLToPath;
void existsSync;
