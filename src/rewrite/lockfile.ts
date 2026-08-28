import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EXIT_ENV, EXIT_FAIL, SlimExit } from "../exit.ts";
import type { Project } from "../project.ts";

/** `--no-install` skips lockfile refresh only. `--keep-original` skips uninstall+install. */
export function shouldRefreshLockfile(opts: {
  keepOriginal?: boolean;
  noInstall?: boolean;
}): boolean {
  return !opts.keepOriginal && !opts.noInstall;
}

type ExecFile = (
  file: string,
  args: readonly string[],
  opts?: {
    cwd?: string;
    encoding?: BufferEncoding;
    stdio?: string | string[];
    env?: NodeJS.ProcessEnv;
  },
) => unknown;

/** Install must update the lockfile after package.json edits; CI frozen-lockfile would fail closed incorrectly. */
export function hermeticPmEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const cacheRoot = join(tmpdir(), "slim-pm-cache");
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env.CI;
  delete env.INIT_CWD;
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_CHANNEL_FD;
  delete env.npm_config_frozen_lockfile;
  delete env.YARN_ENABLE_IMMUTABLE_INSTALLS;
  env.npm_config_cache = join(cacheRoot, "npm");
  env.npm_config_store_dir = join(cacheRoot, "pnpm");
  env.npm_config_store = join(cacheRoot, "pnpm");
  env.YARN_CACHE_FOLDER = join(cacheRoot, "yarn");
  env.BUN_INSTALL_CACHE_DIR = join(cacheRoot, "bun");
  return env;
}

function installEnv(): NodeJS.ProcessEnv {
  const env = hermeticPmEnv();
  delete env.GITHUB_ACTIONS;
  return env;
}

function pmName(lockfile: Project["lockfile"]): string {
  if (lockfile === "pnpm") return "pnpm";
  if (lockfile === "yarn") return "yarn";
  if (lockfile === "bun") return "bun";
  return "npm";
}

function pmBinary(lockfile: Project["lockfile"]): string {
  const name = pmName(lockfile);
  if (process.platform === "win32" && name !== "bun") return `${name}.cmd`;
  return name;
}

export function installCommandFor(lockfile: Project["lockfile"]): string {
  return `${pmName(lockfile)} install`;
}

export function refreshLockfile(
  project: Project,
  opts?: { keepOriginal?: boolean; noInstall?: boolean; frozen?: boolean },
  execFile: ExecFile = execFileSync,
): void {
  if (opts && !shouldRefreshLockfile(opts)) return;
  const cwd = project.root;
  const bin = pmBinary(project.lockfile);
  const env = installEnv();
  if (opts?.frozen) {
    env.npm_config_frozen_lockfile = "true";
    env.YARN_ENABLE_IMMUTABLE_INSTALLS = "true";
  }
  const args = frozenInstallArgs(bin, env, Boolean(opts?.frozen));
  try {
    execFile(bin, args, { cwd, encoding: "utf8", stdio: "inherit", env });
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code) : "";
    const stderr =
      err && typeof err === "object" && "stderr" in err
        ? String((err as { stderr?: unknown }).stderr ?? "")
        : "";
    const msg = err instanceof Error ? err.message : String(err);
    if (code === "ENOENT") {
      throw new SlimExit(EXIT_ENV, `lockfile refresh failed: ${bin} is not installed`);
    }
    const detail = (stderr || msg).slice(0, 800);
    throw new SlimExit(EXIT_FAIL, `lockfile refresh failed; ${bin} install exited nonzero. ${detail}`);
  }
}

function frozenInstallArgs(bin: string, env: NodeJS.ProcessEnv, frozen: boolean): string[] {
  const kind = bin.replace(/\.cmd$/i, "");
  if (kind === "pnpm") {
    const args = ["install"];
    if (env.npm_config_store_dir) args.push("--store-dir", env.npm_config_store_dir);
    args.push(frozen ? "--frozen-lockfile" : "--no-frozen-lockfile");
    return args;
  }
  if (frozen && kind === "yarn") return ["install", "--frozen-lockfile"];
  if (frozen && kind === "bun") return ["install", "--frozen-lockfile"];
  if (frozen && kind === "npm") return ["ci", "--ignore-scripts"];
  return ["install"];
}
