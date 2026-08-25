import { execFileSync } from "node:child_process";
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
function installEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.CI;
  delete env.npm_config_frozen_lockfile;
  delete env.YARN_ENABLE_IMMUTABLE_INSTALLS;
  return env;
}

function pmBinary(lockfile: Project["lockfile"]): string {
  if (lockfile === "pnpm") return "pnpm";
  if (lockfile === "yarn") return "yarn";
  if (lockfile === "bun") return "bun";
  return "npm";
}

export function installCommandFor(lockfile: Project["lockfile"]): string {
  return `${pmBinary(lockfile)} install`;
}

export function refreshLockfile(
  project: Project,
  opts?: { keepOriginal?: boolean; noInstall?: boolean },
  execFile: ExecFile = execFileSync,
): void {
  if (opts && !shouldRefreshLockfile(opts)) return;
  const cwd = project.root;
  const bin = pmBinary(project.lockfile);
  try {
    execFile(bin, ["install"], { cwd, encoding: "utf8", stdio: "inherit", env: installEnv() });
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
