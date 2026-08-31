import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { hermeticPmEnv, refreshLockfile, cmdShim, cmdShimSpawnOpts } from "../src/rewrite/lockfile.ts";
import { applyRevert, type RevertPlan } from "../src/rewrite/revert.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NODE_BIN = dirname(process.execPath);
const COREPACK =
  process.platform === "win32" ? join(NODE_BIN, "corepack.cmd") : join(NODE_BIN, "corepack");
const PM_PATH = `${NODE_BIN}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`;

test("pnpm lockfile refresh does not pass GITHUB_ACTIONS to the installer", () => {
  const prev = process.env.GITHUB_ACTIONS;
  process.env.GITHUB_ACTIONS = "true";
  try {
    let seenEnv: NodeJS.ProcessEnv = {};
    refreshLockfile(
      {
        root: "/tmp/slim-lock-gha",
        lockfile: "pnpm",
        packageJsonPath: "/tmp/slim-lock-gha/package.json",
        packageJson: {},
        tsconfigPath: null,
        srcDir: "/tmp/slim-lock-gha/src",
      },
      {},
      (_file, _args, opts) => {
        seenEnv = opts?.env ?? {};
      },
    );
    assert.equal(seenEnv.GITHUB_ACTIONS, undefined);
    assert.equal(seenEnv.CI, "true");
  } finally {
    if (prev === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = prev;
  }
});

test("pnpm lockfile refresh disables frozen-lockfile so CI can update the lock", () => {
  let seen: string[] = [];
  refreshLockfile(
    {
      root: "/tmp/slim-lock-refresh",
      lockfile: "pnpm",
      packageJsonPath: "/tmp/slim-lock-refresh/package.json",
      packageJson: {},
      tsconfigPath: null,
      srcDir: "/tmp/slim-lock-refresh/src",
    },
    {},
    (file, args) => {
      seen = [file, ...(args as string[])];
    },
  );
  assert.equal(seen[0], cmdShim("pnpm"));
  assert.ok(seen.includes("--no-frozen-lockfile"));
  assert.equal(seen.includes("--frozen-lockfile"), false);
  assert.ok(seen.some((a) => /confirmModulesPurge=false/i.test(a)));
});

test("pnpm rollback refresh keeps frozen-lockfile", () => {
  let seen: string[] = [];
  refreshLockfile(
    {
      root: "/tmp/slim-lock-frozen",
      lockfile: "pnpm",
      packageJsonPath: "/tmp/slim-lock-frozen/package.json",
      packageJson: {},
      tsconfigPath: null,
      srcDir: "/tmp/slim-lock-frozen/src",
    },
    { frozen: true },
    (file, args) => {
      seen = [file, ...(args as string[])];
    },
  );
  assert.ok(seen.includes("--frozen-lockfile"));
  assert.equal(seen.includes("--no-frozen-lockfile"), false);
});

function pmEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return hermeticPmEnv({ PATH: PM_PATH, ...extra });
}

function installPmEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = pmEnv(extra);
  delete env.GITHUB_ACTIONS;
  env.CI = "true";
  return env;
}

test("lockfile-pm test installs set CI so pnpm can purge node_modules without a TTY", () => {
  const prev = process.env.GITHUB_ACTIONS;
  process.env.GITHUB_ACTIONS = "true";
  try {
    const env = installPmEnv();
    assert.equal(env.GITHUB_ACTIONS, undefined);
    assert.equal(env.CI, "true");
  } finally {
    if (prev === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = prev;
  }
});

function which(bin: string): boolean {
  const probe = process.platform === "win32" ? ["cmd", "/c", "where", bin] : ["sh", "-c", `command -v ${bin}`];
  const r = spawnSync(probe[0]!, probe.slice(1), { encoding: "utf8", env: pmEnv() });
  return r.status === 0 && Boolean((r.stdout ?? "").trim());
}

function runSlim(cwd: string, args: string[], extra: NodeJS.ProcessEnv = {}) {
  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", join(ROOT, "src/main.ts"), ...args],
    {
      cwd,
      encoding: "utf8",
      env: pmEnv(extra),
      timeout: 180_000,
    },
  );
}

function prepareCorepack(pkg: string): void {
  const enable = spawnSync(COREPACK, ["enable"], {
    encoding: "utf8",
    env: pmEnv(),
    timeout: 60_000,
    ...cmdShimSpawnOpts(COREPACK),
  });
  const prep = spawnSync(COREPACK, ["prepare", pkg, "--activate"], {
    encoding: "utf8",
    env: pmEnv(),
    timeout: 60_000,
    ...cmdShimSpawnOpts(COREPACK),
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

function lockfileBytes(dir: string, kind: "npm" | "pnpm" | "yarn" | "bun"): Buffer {
  if (kind === "npm") return readFileSync(join(dir, "package-lock.json"));
  if (kind === "pnpm") return readFileSync(join(dir, "pnpm-lock.yaml"));
  if (kind === "yarn") return readFileSync(join(dir, "yarn.lock"));
  if (existsSync(join(dir, "bun.lock"))) return readFileSync(join(dir, "bun.lock"));
  return readFileSync(join(dir, "bun.lockb"));
}

function pmBin(kind: "npm" | "pnpm" | "yarn" | "bun"): string {
  return cmdShim(kind);
}

function runReplace(dir: string, kind: "npm" | "pnpm" | "yarn" | "bun"): void {
  const r = runSlim(
    dir,
    [
      "replace",
      "ms",
      "--no-pr",
      "--no-trace",
      "--budget-ms",
      "800",
      "--workers",
      "1",
    ],
    { GITHUB_ACTIONS: "true" },
  );
  assert.equal(r.status, 0, `${kind}: ${r.stderr}\n${r.stdout}`);
  assertMsGone(dir, kind);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
    devDependencies?: Record<string, string>;
  };
  assert.ok(pkg.devDependencies?.typescript, `${kind} dropped unrelated typescript`);
  assert.ok(existsSync(join(dir, "src", "slim", "ms.ts")), `${kind} missing slice`);
  assert.ok(existsSync(join(dir, "src", "slim", "ms.test.ts")), `${kind} missing standing tests`);
  const check = runSlim(dir, ["check"]);
  assert.equal(check.status, 0, `${kind} check: ${check.stderr}\n${check.stdout}`);
}

function installArgs(kind: "npm" | "pnpm" | "yarn" | "bun"): string[] {
  if (kind === "pnpm") {
    return ["install", "--no-frozen-lockfile", "--config.confirmModulesPurge=false"];
  }
  return ["install"];
}

test("pnpm lockfile-pm helper install disables frozen-lockfile after revert", () => {
  assert.ok(installArgs("pnpm").includes("--no-frozen-lockfile"));
  assert.ok(installArgs("pnpm").some((a) => /confirmModulesPurge=false/i.test(a)));
  assert.deepEqual(installArgs("npm"), ["install"]);
});

function revertAndReinstall(dir: string, kind: "npm" | "pnpm" | "yarn" | "bun"): void {
  const evidence = JSON.parse(readFileSync(join(dir, ".slim", "ms", "evidence.json"), "utf8")) as {
    revert: RevertPlan;
  };
  applyRevert(dir, evidence.revert);
  const inst = spawnSync(pmBin(kind), installArgs(kind), {
    cwd: dir,
    encoding: "utf8",
    env: installPmEnv(),
    timeout: 120_000,
    ...cmdShimSpawnOpts(pmBin(kind)),
  });
  assert.equal(inst.status, 0, `${kind} revert install: ${inst.stderr}\n${inst.stdout}`);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  assert.equal(pkg.dependencies?.ms, "2.1.3", `${kind} revert did not restore ms`);
}

function installKind(dir: string, kind: "npm" | "pnpm" | "yarn" | "bun"): void {
  const inst = spawnSync(pmBin(kind), installArgs(kind), {
    cwd: dir,
    encoding: "utf8",
    env: installPmEnv(),
    timeout: 120_000,
    ...cmdShimSpawnOpts(pmBin(kind)),
  });
  assert.equal(inst.status, 0, `${kind} install: ${inst.stderr}\n${inst.stdout}`);
}

function runReplaceRollback(dir: string, kind: "npm" | "pnpm" | "yarn" | "bun"): void {
  const beforePkg = readFileSync(join(dir, "package.json"));
  const beforeLock = lockfileBytes(dir, kind);
  const r = runSlim(
    dir,
    ["replace", "ms", "--no-pr", "--no-trace", "--budget-ms", "800", "--workers", "1"],
    { SLIM_INJECT_FAIL: "after-lockfile", GITHUB_ACTIONS: "true" },
  );
  assert.notEqual(r.status, 0, `${kind} inject should fail`);
  assert.match(r.stderr, /injected failure: after-lockfile/);
  assert.deepEqual(readFileSync(join(dir, "package.json")), beforePkg, `${kind} package.json`);
  assert.deepEqual(lockfileBytes(dir, kind), beforeLock, `${kind} lockfile`);
  assert.equal(existsSync(join(dir, "src", "slim", "ms.ts")), false, `${kind} leftover slice`);
  assert.equal(existsSync(join(dir, ".slim", "ms", "evidence.json")), false, `${kind} leftover evidence`);
}

test("lockfile-pm replace CLI does not bind a half-written dist", () => {
  const src = readFileSync(new URL(import.meta.url), "utf8");
  assert.match(src, /src\/main\.ts/);
  assert.doesNotMatch(src, /existsSync\(dist\) && !extra\.SLIM_INJECT_FAIL/);
});

test("npm lockfile replace removes ms from package-lock.json", { timeout: 180_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-pm-npm-"));
  writeApp(dir);
  installKind(dir, "npm");
  assert.ok(existsSync(join(dir, "package-lock.json")));
  runReplace(dir, "npm");
  revertAndReinstall(dir, "npm");
});

test("pnpm lockfile replace removes ms from pnpm-lock.yaml", { timeout: 180_000 }, () => {
  if (!which("pnpm")) prepareCorepack("pnpm@9.15.9");
  if (!which("pnpm")) throw new Error("pnpm is required for Phase 8 lockfile receipts");
  const dir = mkdtempSync(join(tmpdir(), "slim-pm-pnpm-"));
  writeApp(dir);
  installKind(dir, "pnpm");
  assert.ok(existsSync(join(dir, "pnpm-lock.yaml")));
  runReplace(dir, "pnpm");
  revertAndReinstall(dir, "pnpm");
});

test("yarn lockfile replace removes ms from yarn.lock", { timeout: 180_000 }, () => {
  prepareCorepack("yarn@1.22.22");
  if (!which("yarn")) throw new Error("yarn is required for Phase 8 lockfile receipts");
  const dir = mkdtempSync(join(tmpdir(), "slim-pm-yarn-"));
  writeApp(dir);
  installKind(dir, "yarn");
  assert.ok(existsSync(join(dir, "yarn.lock")));
  runReplace(dir, "yarn");
  revertAndReinstall(dir, "yarn");
});

test("bun lockfile replace removes ms from bun.lock", { timeout: 180_000 }, () => {
  if (!which("bun")) {
    throw new Error("bun is required for Phase 8 lockfile receipts. Install bun (CI: oven-sh/setup-bun).");
  }
  const dir = mkdtempSync(join(tmpdir(), "slim-pm-bun-"));
  writeApp(dir);
  installKind(dir, "bun");
  assert.ok(existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb")), "missing bun lockfile");
  runReplace(dir, "bun");
  revertAndReinstall(dir, "bun");
});

test("npm lockfile refresh failure rolls back package.json and lockfile", { timeout: 180_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-pm-npm-rb-"));
  writeApp(dir);
  installKind(dir, "npm");
  runReplaceRollback(dir, "npm");
});

test("pnpm lockfile refresh failure rolls back package.json and lockfile", { timeout: 180_000 }, () => {
  if (!which("pnpm")) prepareCorepack("pnpm@9.15.9");
  if (!which("pnpm")) throw new Error("pnpm is required for Phase 8 lockfile receipts");
  const dir = mkdtempSync(join(tmpdir(), "slim-pm-pnpm-rb-"));
  writeApp(dir);
  installKind(dir, "pnpm");
  runReplaceRollback(dir, "pnpm");
});

test("yarn lockfile refresh failure rolls back package.json and lockfile", { timeout: 180_000 }, () => {
  prepareCorepack("yarn@1.22.22");
  if (!which("yarn")) throw new Error("yarn is required for Phase 8 lockfile receipts");
  const dir = mkdtempSync(join(tmpdir(), "slim-pm-yarn-rb-"));
  writeApp(dir);
  installKind(dir, "yarn");
  runReplaceRollback(dir, "yarn");
});

test("bun lockfile refresh failure rolls back package.json and lockfile", { timeout: 180_000 }, () => {
  if (!which("bun")) {
    throw new Error("bun is required for Phase 8 lockfile receipts. Install bun (CI: oven-sh/setup-bun).");
  }
  const dir = mkdtempSync(join(tmpdir(), "slim-pm-bun-rb-"));
  writeApp(dir);
  installKind(dir, "bun");
  runReplaceRollback(dir, "bun");
});
