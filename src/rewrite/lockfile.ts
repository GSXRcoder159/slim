import { execFileSync } from "node:child_process";
import type { Project } from "../project.ts";

/** `--no-install` skips lockfile refresh only. `--keep-original` skips uninstall+install. */
export function shouldRefreshLockfile(opts: {
  keepOriginal?: boolean;
  noInstall?: boolean;
}): boolean {
  return !opts.keepOriginal && !opts.noInstall;
}

export function refreshLockfile(
  project: Project,
  opts?: { keepOriginal?: boolean; noInstall?: boolean },
): void {
  if (opts && !shouldRefreshLockfile(opts)) return;
  const cwd = project.root;
  try {
    if (project.lockfile === "pnpm") {
      execFileSync("pnpm", ["install"], { cwd, stdio: "inherit" });
    } else if (project.lockfile === "yarn") {
      execFileSync("yarn", ["install"], { cwd, stdio: "inherit" });
    } else if (project.lockfile === "bun") {
      execFileSync("bun", ["install"], { cwd, stdio: "inherit" });
    } else {
      execFileSync("npm", ["install"], { cwd, stdio: "inherit" });
    }
  } catch (err) {
    process.stderr.write(
      `lockfile refresh failed; run your package manager install. ${err instanceof Error ? err.message : err}\n`,
    );
  }
}
