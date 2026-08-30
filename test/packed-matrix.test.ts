import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  cpSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { hermeticPmEnv, execPm, cmdShimSpawnOpts } from "../src/rewrite/lockfile.ts";
import { npmPackTo } from "./helpers/llm-replace.ts";
import { packageImport, packageNodeModulesDir } from "../src/release/identity.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = tmpdir();

function run(
  bin: string,
  args: string[],
  cwd: string,
  extraEnv: NodeJS.ProcessEnv = {},
  timeoutMs = 180_000,
): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(bin, args, {
    cwd,
    encoding: "utf8",
    env: hermeticPmEnv({ ...extraEnv }),
    timeout: timeoutMs,
    ...cmdShimSpawnOpts(bin),
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function packTarball(): { dir: string; tarball: string } {
  mkdirSync(TMP, { recursive: true });
  if (!existsSync(join(ROOT, "dist", ".slim-build.json"))) {
    execPm("npm", ["run", "build"], { cwd: ROOT, encoding: "utf8", timeout: 60_000 });
  }
  const dir = mkdtempSync(join(TMP, "slim-matrix-pack-"));
  return { dir, tarball: npmPackTo(dir) };
}

function copyFixture(name: string, dest: string, stripSlim = false): void {
  const src = join(ROOT, "fixtures", name);
  cpSync(src, dest, {
    recursive: true,
    filter: (p) => {
      const rel = relative(src, p).replace(/\\/g, "/");
      if (!rel || rel === ".") return true;
      if (rel.split(/[/\\]/)[0] === "node_modules") return false;
      if (stripSlim) {
        if (rel.startsWith("src/slim") || rel.startsWith(".slim")) return false;
        if (rel === "package-lock.json" || rel === "slim.json") return false;
      }
      return true;
    },
  });
}

function slimJs(cwd: string): string {
  return join(packageNodeModulesDir(cwd), "dist", "main.js");
}

function installSlim(cwd: string, tarball: string, ignoreScripts = false): void {
  const args = ["install", tarball];
  if (ignoreScripts) args.push("--ignore-scripts");
  execPm("npm", args, { cwd, encoding: "utf8", timeout: 120_000, env: hermeticPmEnv() });
}

test("packed consumer: doctor scan inspect traced lodash replace check evidence", { timeout: 300_000 }, () => {
  const { dir: packDir, tarball } = packTarball();
  const dest = mkdtempSync(join(TMP, "slim-matrix-lodash-"));
  try {
    copyFixture("lodash-get-debounce", dest, true);
    writeFileSync(
      join(dest, "src", "index.ts"),
      `import _ from "lodash";

export function pickUser(user: { profile?: { name?: string | null } } | null): string {
  return _.get(user, "profile.name", "anonymous") as string;
}

export function nestedRef(obj: { a: { b: { c: number } } }) {
  return _.get(obj, "a.b");
}

export function nestedRefPath(obj: { a: { b: { c: number } } }) {
  return _.get(obj, ["a", "b"]);
}

export const ping = _.debounce((n: number) => n, 50);

export function schedule(fn: () => void): ReturnType<typeof _.debounce> {
  return _.debounce(fn, 25);
}

export function badDebounce(): ReturnType<typeof _.debounce> {
  return _.debounce(null as never, 10);
}
`,
    );
    const pkgPath = join(dest, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      dependencies?: Record<string, string>;
      scripts?: Record<string, string>;
    };
    pkg.dependencies = { ...(pkg.dependencies ?? {}), lodash: "4.17.21" };
    pkg.scripts = {
      ...(pkg.scripts ?? {}),
      test: "node --experimental-strip-types --test src/index.test.ts",
    };
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
    installSlim(dest, tarball);
    const bin = slimJs(dest);
    const doctor = run(process.execPath, [bin, "doctor", "--json"], dest);
    assert.equal(doctor.status, 0, doctor.stderr);
    assert.equal(JSON.parse(doctor.stdout).ok, true);
    const scan = run(process.execPath, [bin, "scan", "--json"], dest);
    assert.equal(scan.status, 0, scan.stderr);
    assert.ok(Array.isArray(JSON.parse(scan.stdout).rows));
    const inspect = run(process.execPath, [bin, "inspect", "lodash", "--json"], dest);
    assert.equal(inspect.status, 0, inspect.stderr + inspect.stdout);
    const replaced = run(
      process.execPath,
      [bin, "replace", "lodash", "--no-pr", "--budget-ms", "800", "--workers", "1", "--seed", "1"],
      dest,
    );
    assert.equal(replaced.status, 0, replaced.stderr + replaced.stdout);
    assert.match(replaced.stdout + replaced.stderr, /fuzz/i);
    const pkgAfter = JSON.parse(readFileSync(pkgPath, "utf8")) as { dependencies?: Record<string, string> };
    assert.equal(pkgAfter.dependencies?.lodash, undefined);
    assert.ok(existsSync(join(dest, "src/slim/lodash.ts")));
    assert.ok(existsSync(join(dest, "src/slim/lodash.test.ts")));
    assert.ok(existsSync(join(dest, ".slim/lodash/evidence.md")));
    assert.ok(existsSync(join(dest, ".slim/lodash/evidence.json")));
    assert.ok(existsSync(join(dest, "wrangler.toml")), "Worker-shaped fixture lost wrangler.toml");
    const evidence = JSON.parse(readFileSync(join(dest, ".slim/lodash/evidence.json"), "utf8")) as {
      fuzz: { comparisons: number };
    };
    assert.ok(evidence.fuzz.comparisons > 0);
    const stood = run(process.execPath, ["--experimental-strip-types", "--test", "src/slim/lodash.test.ts"], dest);
    assert.equal(stood.status, 0, stood.stderr + stood.stdout);
    const checked = run(process.execPath, [bin, "check"], dest);
    assert.equal(checked.status, 0, checked.stderr + checked.stdout);
  } finally {
    rmSync(dest, { recursive: true, force: true });
    rmSync(packDir, { recursive: true, force: true });
  }
});

test("packed --no-trace evidence is not trace-closed", { timeout: 180_000 }, () => {
  const { dir: packDir, tarball } = packTarball();
  const dest = mkdtempSync(join(TMP, "slim-matrix-static-"));
  try {
    copyFixture("ms-parse", dest);
    installSlim(dest, tarball);
    const bin = slimJs(dest);
    const replaced = run(
      process.execPath,
      [bin, "replace", "ms", "--no-pr", "--no-trace", "--budget-ms", "800", "--workers", "1"],
      dest,
    );
    assert.equal(replaced.status, 0, replaced.stderr + replaced.stdout);
    const env = JSON.parse(readFileSync(join(dest, ".slim/ms/envelope.json"), "utf8")) as {
      closure: { confidence: string };
    };
    assert.notEqual(env.closure.confidence, "trace-closed");
    const md = readFileSync(join(dest, ".slim/ms/evidence.md"), "utf8");
    assert.doesNotMatch(md, /trace-closed/);
  } finally {
    rmSync(dest, { recursive: true, force: true });
    rmSync(packDir, { recursive: true, force: true });
  }
});

test("packed open-envelope and native refusals exit 3", { timeout: 180_000 }, () => {
  const { dir: packDir, tarball } = packTarball();
  const a = mkdtempSync(join(TMP, "slim-matrix-dyn-"));
  const b = mkdtempSync(join(TMP, "slim-matrix-nat-"));
  try {
    copyFixture("lodash-dynamic-refuse", a);
    copyFixture("native-addon-refuse", b);
    installSlim(a, tarball, true);
    installSlim(b, tarball, true);
    const dyn = run(process.execPath, [slimJs(a), "replace", "lodash", "--no-pr", "--no-trace"], a);
    assert.equal(dyn.status, 3, dyn.stderr + dyn.stdout);
    const nat = run(process.execPath, [slimJs(b), "replace", "better-sqlite3", "--no-pr", "--no-trace"], b);
    assert.equal(nat.status, 3, nat.stderr + nat.stdout);
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
    rmSync(packDir, { recursive: true, force: true });
  }
});

test("packed CJS replace produces requireable companion; vitest export loads", { timeout: 180_000 }, () => {
  const { dir: packDir, tarball } = packTarball();
  const dest = mkdtempSync(join(TMP, "slim-matrix-cjs-"));
  try {
    mkdirSync(join(dest, "src"), { recursive: true });
    writeFileSync(
      join(dest, "package.json"),
      JSON.stringify({
        name: "cjs-app",
        private: true,
        scripts: { test: "node --test src/index.test.cjs" },
        dependencies: { ms: "2.1.3" },
        devDependencies: { typescript: "^5.9.2" },
      }) + "\n",
    );
    writeFileSync(
      join(dest, "src", "index.cjs"),
      `const ms = require("ms");\nmodule.exports = { hour: () => ms("1h") };\n`,
    );
    writeFileSync(
      join(dest, "src", "index.test.cjs"),
      `const { test } = require("node:test");\nconst assert = require("node:assert/strict");\nconst { hour } = require("./index.cjs");\ntest("hour", () => assert.equal(hour(), 3600000));\n`,
    );
    installSlim(dest, tarball);
    const bin = slimJs(dest);
    const replaced = run(
      process.execPath,
      [bin, "replace", "ms", "--no-pr", "--no-trace", "--no-install", "--budget-ms", "800", "--workers", "1"],
      dest,
    );
    assert.equal(replaced.status, 0, replaced.stderr + replaced.stdout);
    assert.ok(existsSync(join(dest, "src/slim/ms.cjs")));
    const ran = run(process.execPath, ["--test", "src/index.test.cjs"], dest);
    assert.equal(ran.status, 0, ran.stderr + ran.stdout);

    const vitestJs = join(packageNodeModulesDir(dest), "dist", "trace", "vitest.js");
    const vitestLoad = run(
      process.execPath,
      [
        "-e",
        `import(${JSON.stringify(pathToFileURL(vitestJs).href)}).then((m) => {
          if (typeof m.slimVitest !== "function" && typeof m.default !== "function") process.exit(1);
          console.log("vitest-ok");
        })`,
      ],
      dest,
    );
    assert.equal(vitestLoad.status, 0, vitestLoad.stderr);
    assert.match(vitestLoad.stdout, /vitest-ok/);
  } finally {
    rmSync(dest, { recursive: true, force: true });
    rmSync(packDir, { recursive: true, force: true });
  }
});

test("packed vitest plugin runs a tiny ESM consumer test", { timeout: 180_000 }, () => {
  const { dir: packDir, tarball } = packTarball();
  const dest = mkdtempSync(join(TMP, "slim-matrix-vitest-"));
  try {
    mkdirSync(join(dest, "src"), { recursive: true });
    writeFileSync(
      join(dest, "package.json"),
      JSON.stringify({
        name: "vitest-app",
        private: true,
        type: "module",
        scripts: { test: "vitest run" },
        dependencies: { ms: "2.1.3" },
        devDependencies: { typescript: "^5.9.2" },
      }) + "\n",
    );
    writeFileSync(
      join(dest, "src", "index.ts"),
      `import ms from "ms";\nexport function hour(): number { return ms("1h") as number; }\n`,
    );
    writeFileSync(
      join(dest, "src", "hour.test.ts"),
      `import { test, expect } from "vitest";\nimport { hour } from "./index.ts";\ntest("hour", () => expect(hour()).toBe(3600000));\n`,
    );
    writeFileSync(
      join(dest, "vitest.config.mjs"),
      `import slimVitest from "${packageImport("vitest")}";\nexport default { plugins: [slimVitest({ packages: ["ms"] })] };\n`,
    );
    installSlim(dest, tarball);
    execPm("npm", ["install", "vitest@3.2.4", "--save-dev", "--no-audit", "--no-fund"], {
      cwd: dest,
      encoding: "utf8",
      timeout: 120_000,
    });
    const bin = slimJs(dest);
    const replaced = run(
      process.execPath,
      [bin, "replace", "ms", "--no-pr", "--no-trace", "--budget-ms", "800", "--workers", "1"],
      dest,
    );
    assert.equal(replaced.status, 0, replaced.stderr + replaced.stdout);
    const vitestBin =
      process.platform === "win32"
        ? join(dest, "node_modules", ".bin", "vitest.cmd")
        : join(dest, "node_modules", ".bin", "vitest");
    const vitestRun = run(vitestBin, ["run", "--config", "vitest.config.mjs", "src/hour.test.ts"], dest, {}, 120_000);
    assert.equal(vitestRun.status, 0, vitestRun.stderr + vitestRun.stdout);
    assert.match(vitestRun.stdout + vitestRun.stderr, /1 passed|Test Files\s+1 passed/);
  } finally {
    rmSync(dest, { recursive: true, force: true });
    rmSync(packDir, { recursive: true, force: true });
  }
});
