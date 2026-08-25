import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function runSlim(cwd: string, args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, CI: "1" };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_CHANNEL_FD;
  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", join(ROOT, "src/main.ts"), ...args],
    { cwd, encoding: "utf8", env, timeout: 180_000 },
  );
}

function npmInstall(cwd: string): void {
  const r = spawnSync("npm", ["install", "--ignore-scripts"], { cwd, encoding: "utf8", timeout: 120_000 });
  assert.equal(r.status, 0, r.stderr);
}

function tsconfig(): string {
  return JSON.stringify(
    {
      compilerOptions: {
        target: "ES2023",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
      },
      include: ["src"],
    },
    null,
    2,
  );
}

const LODASH_TEST = `import { test } from "node:test";
import assert from "node:assert/strict";
import * as mod from "./index.ts";
test("call", () => {
  const fn = "get" in mod ? mod.get : mod.value;
  assert.equal(fn({ a: 1 }, "a"), 1);
});
`;

function writeLodashApp(dir: string, src: string): void {
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: "style-lodash",
        private: true,
        type: "module",
        scripts: { test: "node --experimental-strip-types --test src/index.test.ts" },
        dependencies: { lodash: "4.17.21" },
        devDependencies: { typescript: "^5.9.2" },
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(join(dir, "tsconfig.json"), tsconfig() + "\n");
  writeFileSync(join(dir, "src", "index.ts"), src);
  writeFileSync(join(dir, "src", "index.test.ts"), LODASH_TEST);
}

test("default / named / namespace / per-method lodash styles run after dep removal", { timeout: 300_000 }, () => {
  const styles: Array<{ name: string; src: string }> = [
    {
      name: "default",
      src: `import _ from "lodash";\nexport function value() { return _.get({ a: 1 }, "a") as number; }\n`,
    },
    {
      name: "named",
      src: `import { get } from "lodash";\nexport function value() { return get({ a: 1 }, "a") as number; }\n`,
    },
    {
      name: "namespace",
      src: `import * as lodash from "lodash";\nexport function get(obj: object, path: string) { return lodash.get(obj, path) as number; }\n`,
    },
    {
      name: "per-method",
      src: `import get from "lodash/get";\nexport function value() { return get({ a: 1 }, "a") as number; }\n`,
    },
  ];
  for (const s of styles) {
    const dir = mkdtempSync(join(tmpdir(), `slim-style-${s.name}-`));
    writeLodashApp(dir, s.src);
    npmInstall(dir);
    const r = runSlim(dir, [
      "replace",
      "lodash",
      "--no-pr",
      "--no-trace",
      "--no-install",
      "--budget-ms",
      "800",
      "--workers",
      "1",
    ]);
    assert.equal(r.status, 0, `${s.name}: ${r.stderr}\n${r.stdout}`);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    assert.equal(pkg.dependencies?.lodash, undefined, s.name);
    const ran = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--test", "src/index.test.ts"],
      { cwd: dir, encoding: "utf8", timeout: 30_000 },
    );
    assert.equal(ran.status, 0, `${s.name} run:\n${ran.stderr}\n${ran.stdout}`);
  }
});

test("CJS require runs after dep removal via .cjs companion", { timeout: 180_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-style-cjs-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: "cjs-app",
        private: true,
        scripts: { test: "node --test src/index.test.cjs" },
        dependencies: { ms: "2.1.3" },
        devDependencies: { typescript: "^5.9.2" },
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(join(dir, "tsconfig.json"), tsconfig() + "\n");
  writeFileSync(
    join(dir, "src", "index.cjs"),
    `const ms = require("ms");\nmodule.exports = { hour: () => ms("1h") };\n`,
  );
  writeFileSync(
    join(dir, "src", "index.test.cjs"),
    `const { test } = require("node:test");\nconst assert = require("node:assert/strict");\nconst { hour } = require("./index.cjs");\ntest("hour", () => assert.equal(hour(), 3600000));\n`,
  );
  npmInstall(dir);
  const r = runSlim(dir, [
    "replace",
    "ms",
    "--no-pr",
    "--no-trace",
    "--no-install",
    "--budget-ms",
    "800",
    "--workers",
    "1",
  ]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(existsSync(join(dir, "src", "slim", "ms.cjs")), "missing CJS companion");
  const idx = readFileSync(join(dir, "src", "index.cjs"), "utf8");
  assert.match(idx, /require\("\.\/slim\/ms\.cjs"\)/);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  assert.equal(pkg.dependencies?.ms, undefined);
  const ran = spawnSync(process.execPath, ["--test", "src/index.test.cjs"], {
    cwd: dir,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(ran.status, 0, ran.stderr + ran.stdout);
});
