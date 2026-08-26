import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { hermeticPmEnv } from "../src/rewrite/lockfile.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NODE_BIN = dirname(process.execPath);
const COREPACK =
  process.platform === "win32" ? join(NODE_BIN, "corepack.cmd") : join(NODE_BIN, "corepack");
const PM_PATH = `${NODE_BIN}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`;

function pmEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return hermeticPmEnv({ PATH: PM_PATH, ...extra });
}

function which(bin: string): boolean {
  const probe = process.platform === "win32" ? ["cmd", "/c", "where", bin] : ["sh", "-c", `command -v ${bin}`];
  const r = spawnSync(probe[0]!, probe.slice(1), { encoding: "utf8", env: pmEnv() });
  return r.status === 0 && Boolean((r.stdout ?? "").trim());
}

function runSlim(cwd: string, args: string[]) {
  const dist = join(ROOT, "dist", "main.js");
  const argv = existsSync(dist)
    ? [dist, ...args]
    : ["--experimental-strip-types", join(ROOT, "src/main.ts"), ...args];
  return spawnSync(process.execPath, argv, {
    cwd,
    encoding: "utf8",
    env: pmEnv({ CI: "1" }),
    timeout: 180_000,
  });
}

function prepareCorepack(pkg: string): void {
  const enable = spawnSync(COREPACK, ["enable"], { encoding: "utf8", env: pmEnv(), timeout: 60_000 });
  const prep = spawnSync(COREPACK, ["prepare", pkg, "--activate"], {
    encoding: "utf8",
    env: pmEnv(),
    timeout: 60_000,
  });
  if (prep.status !== 0) {
    throw new Error(
      `${pkg} is required for Phase 8 lockfile receipts: ${prep.stderr || prep.stdout || enable.stderr}`,
    );
  }
}

function writeApp(dir: string): void {
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: "pm-fix",
        private: true,
        type: "module",
        scripts: { test: "node --experimental-strip-types --test src/index.test.ts" },
        dependencies: { ms: "2.1.3" },
        devDependencies: { typescript: "^5.9.2" },
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2023",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
      },
      include: ["src"],
    }) + "\n",
  );
  writeFileSync(join(dir, "src", "index.ts"), `import ms from "ms";\nexport const hour = () => ms("1h") as number;\n`);
  writeFileSync(
    join(dir, "src", "index.test.ts"),
    `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { hour } from "./index.ts";\ntest("h", () => assert.equal(hour(), 3600000));\n`,
  );
}

function assertMsGone(dir: string, kind: "npm" | "pnpm" | "yarn" | "bun"): void {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  assert.equal(pkg.dependencies?.ms, undefined, `${kind} package.json still has ms`);
  if (kind === "npm") {
    const lock = JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8")) as {
      dependencies?: Record<string, unknown>;
      packages?: Record<string, { dependencies?: Record<string, string> }>;
    };
    assert.equal(lock.packages?.[""]?.dependencies?.ms, undefined);
    assert.equal(lock.dependencies?.ms, undefined);
  } else if (kind === "pnpm") {
    const lock = readFileSync(join(dir, "pnpm-lock.yaml"), "utf8");
    assert.doesNotMatch(lock, /^ {2}ms:/m);
  } else if (kind === "yarn") {
    const lock = readFileSync(join(dir, "yarn.lock"), "utf8");
    assert.doesNotMatch(lock, /^ms@/m);
  } else {
    const text = existsSync(join(dir, "bun.lock")) ? readFileSync(join(dir, "bun.lock"), "utf8") : "";
    if (text) assert.doesNotMatch(text, /"ms"\s*:\s*"2\.1\.3"/);
  }
}

function runReplace(dir: string, kind: "npm" | "pnpm" | "yarn" | "bun"): void {
  const r = runSlim(dir, [
    "replace",
    "ms",
    "--no-pr",
    "--no-trace",
    "--budget-ms",
    "800",
    "--workers",
    "1",
  ]);
  assert.equal(r.status, 0, `${kind}: ${r.stderr}\n${r.stdout}`);
  assertMsGone(dir, kind);
}

test("npm lockfile replace removes ms from package-lock.json", { timeout: 180_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-pm-npm-"));
  writeApp(dir);
  const inst = spawnSync("npm", ["install"], { cwd: dir, encoding: "utf8", env: pmEnv(), timeout: 120_000 });
  assert.equal(inst.status, 0, inst.stderr);
  assert.ok(existsSync(join(dir, "package-lock.json")));
  runReplace(dir, "npm");
});

test("pnpm lockfile replace removes ms from pnpm-lock.yaml", { timeout: 180_000 }, () => {
  if (!which("pnpm")) prepareCorepack("pnpm@9.15.9");
  if (!which("pnpm")) throw new Error("pnpm is required for Phase 8 lockfile receipts");
  const dir = mkdtempSync(join(tmpdir(), "slim-pm-pnpm-"));
  writeApp(dir);
  const inst = spawnSync("pnpm", ["install"], { cwd: dir, encoding: "utf8", env: pmEnv(), timeout: 120_000 });
  assert.equal(inst.status, 0, inst.stderr);
  assert.ok(existsSync(join(dir, "pnpm-lock.yaml")));
  runReplace(dir, "pnpm");
});

test("yarn lockfile replace removes ms from yarn.lock", { timeout: 180_000 }, () => {
  prepareCorepack("yarn@1.22.22");
  if (!which("yarn")) throw new Error("yarn is required for Phase 8 lockfile receipts");
  const dir = mkdtempSync(join(tmpdir(), "slim-pm-yarn-"));
  writeApp(dir);
  const inst = spawnSync("yarn", ["install"], { cwd: dir, encoding: "utf8", env: pmEnv(), timeout: 120_000 });
  assert.equal(inst.status, 0, inst.stderr);
  assert.ok(existsSync(join(dir, "yarn.lock")));
  runReplace(dir, "yarn");
});

test("bun lockfile replace removes ms from bun.lock", { timeout: 180_000 }, () => {
  if (!which("bun")) {
    throw new Error("bun is required for Phase 8 lockfile receipts. Install bun (CI: oven-sh/setup-bun).");
  }
  const dir = mkdtempSync(join(tmpdir(), "slim-pm-bun-"));
  writeApp(dir);
  const inst = spawnSync("bun", ["install"], { cwd: dir, encoding: "utf8", env: pmEnv(), timeout: 120_000 });
  assert.equal(inst.status, 0, inst.stderr);
  assert.ok(existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb")), "missing bun lockfile");
  runReplace(dir, "bun");
});
