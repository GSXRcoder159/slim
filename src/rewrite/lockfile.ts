import { execFileSync } from "node:child_process";
import type { Project } from "../project.ts";

export function refreshLockfile(project: Project): void {
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
