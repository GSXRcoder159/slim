import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT_ENV, EXIT_FAIL, SlimExit } from "../src/exit.ts";
import { refreshLockfile, shouldRefreshLockfile } from "../src/rewrite/lockfile.ts";
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
  const calls: Array<{ file: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv }> = [];
  refreshLockfile(project("npm"), undefined, (file, args, opts) => {
    calls.push({
      file: String(file),
      args: args as string[],
      cwd: String((opts as { cwd?: string }).cwd),
      env: (opts as { env?: NodeJS.ProcessEnv }).env,
    });
    return Buffer.from("");
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.file, "npm");
  assert.deepEqual(calls[0]!.args, ["install"]);
  assert.equal(calls[0]!.env?.CI, undefined);
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
  assert.deepEqual(seen, ["pnpm", "yarn", "bun"]);
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
