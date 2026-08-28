import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT_ENV, EXIT_FAIL, SlimExit } from "../src/exit.ts";
import { refreshLockfile, shouldRefreshLockfile, cmdShim, cmdShimSpawnOpts, scriptSpawnOpts } from "../src/rewrite/lockfile.ts";
import type { Project } from "../src/project.ts";

function project(lockfile: Project["lockfile"]): Project {
  const root = mkdtempSync(join(tmpdir(), "slim-lock-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "t", version: "1.0.0" }));
  return {
    root,
    packageJsonPath: join(root, "package.json"),
    packageJson: { name: "t" },
    lockfile,
    tsconfigPath: null,
    srcDir: root,
  };
}

test("refreshLockfile npm install on npm lockfile", () => {
  const calls: Array<{
    file: string;
    args: string[];
    cwd: string;
    env?: NodeJS.ProcessEnv;
    shell?: boolean;
  }> = [];
  refreshLockfile(project("npm"), undefined, (file, args, opts) => {
    calls.push({
      file: String(file),
      args: args as string[],
      cwd: String((opts as { cwd?: string }).cwd),
      env: (opts as { env?: NodeJS.ProcessEnv }).env,
      shell: (opts as { shell?: boolean }).shell,
    });
    return Buffer.from("");
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.file, cmdShim("npm"));
  assert.deepEqual(calls[0]!.args, ["install"]);
  assert.equal(calls[0]!.shell, process.platform === "win32" ? true : undefined);
  assert.equal(calls[0]!.env?.CI, undefined);
  assert.equal(calls[0]!.env?.INIT_CWD, undefined);
  assert.match(calls[0]!.env?.npm_config_cache ?? "", /slim-pm-cache/);
});

test("refreshLockfile pnpm install uses an isolated store-dir", () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  refreshLockfile(project("pnpm"), undefined, (file, args) => {
    calls.push({ file: String(file), args: args as string[] });
    return Buffer.from("");
  });
  assert.equal(calls[0]!.file, cmdShim("pnpm"));
  assert.equal(calls[0]!.args[0], "install");
  assert.equal(calls[0]!.args[1], "--store-dir");
  assert.match(calls[0]!.args[2] ?? "", /slim-pm-cache/);
});

test("refreshLockfile pnpm/yarn/bun commands", () => {
  const seen: string[] = [];
  const exec = (file: string) => {
    seen.push(String(file));
    return Buffer.from("");
  };
  refreshLockfile(project("pnpm"), undefined, exec as typeof import("node:child_process").execFileSync);
  refreshLockfile(project("yarn"), undefined, exec as typeof import("node:child_process").execFileSync);
  refreshLockfile(project("bun"), undefined, exec as typeof import("node:child_process").execFileSync);
  assert.deepEqual(seen, [cmdShim("pnpm"), cmdShim("yarn"), "bun"]);
});

test("refreshLockfile missing binary is EXIT_ENV", () => {
  const err = Object.assign(new Error("spawn pnpm ENOENT"), { code: "ENOENT" });
  assert.throws(
    () =>
      refreshLockfile(project("pnpm"), undefined, () => {
        throw err;
      }),
    (e: unknown) => e instanceof SlimExit && e.code === EXIT_ENV && /pnpm/i.test(e.message),
  );
});

test("refreshLockfile nonzero install is EXIT_FAIL", () => {
  const err = Object.assign(new Error("Command failed: npm install"), {
    status: 1,
    stderr: "peer dep conflict",
  });
  assert.throws(
    () =>
      refreshLockfile(project("npm"), undefined, () => {
        throw err;
      }),
    (e: unknown) =>
      e instanceof SlimExit &&
      e.code === EXIT_FAIL &&
      /lockfile refresh failed/i.test(e.message) &&
      /peer dep/i.test(e.message),
  );
});

test("shouldRefreshLockfile still skips keep-original and no-install", () => {
  assert.equal(shouldRefreshLockfile({ keepOriginal: false, noInstall: false }), true);
  assert.equal(shouldRefreshLockfile({ keepOriginal: false, noInstall: true }), false);
  assert.equal(shouldRefreshLockfile({ keepOriginal: true, noInstall: false }), false);
});

test("cmdShim routes Windows cmd shims through cmd.exe", () => {
  if (process.platform === "win32") {
    assert.equal(cmdShim("npm"), "npm.cmd");
    assert.equal(cmdShim("pnpm"), "pnpm.cmd");
    assert.equal(cmdShim("bun"), "bun");
    assert.equal(cmdShimSpawnOpts("npm.cmd").shell, true);
    assert.equal(cmdShimSpawnOpts("bun").shell, undefined);
    assert.equal(scriptSpawnOpts("vitest").shell, true);
    assert.equal(scriptSpawnOpts(process.execPath).shell, undefined);
  } else {
    assert.equal(cmdShim("npm"), "npm");
    assert.equal(cmdShimSpawnOpts("npm").shell, undefined);
    assert.equal(scriptSpawnOpts("vitest").shell, undefined);
  }
});

test("refreshLockfile frozen restore does not rewrite the lockfile", () => {
  const calls: Array<{ file: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
  refreshLockfile(project("npm"), { frozen: true }, (file, args, opts) => {
    calls.push({
      file: String(file),
      args: args as string[],
      env: (opts as { env?: NodeJS.ProcessEnv }).env,
    });
    return Buffer.from("");
  });
  assert.deepEqual(calls[0]!.args, ["ci", "--ignore-scripts"]);
  assert.equal(calls[0]!.env?.npm_config_frozen_lockfile, "true");
  refreshLockfile(project("pnpm"), { frozen: true }, (file, args) => {
    calls.push({ file: String(file), args: args as string[] });
    return Buffer.from("");
  });
  assert.ok(calls[1]!.args.includes("--frozen-lockfile"));
});
