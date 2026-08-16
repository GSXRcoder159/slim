import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { registerHooks } from "node:module";
import { EXIT_OK, EXIT_ENV } from "./exit.ts";
import type { CliArgs } from "./cli.ts";
import { loadProject } from "./project.ts";

export interface DoctorReport {
  node: string;
  nodeOk: boolean;
  registerHooks: boolean;
  gh: boolean;
  typescript: boolean;
  git: boolean;
  lockfile: string | null;
  issues: string[];
}

function hasBin(bin: string): boolean {
  try {
    execFileSync(bin, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    try {
      execFileSync(bin, ["version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }
}

export function collectDoctor(cwd = process.cwd()): DoctorReport {
  const issues: string[] = [];
  const majorMinor = process.versions.node.split(".").map(Number);
  const nodeOk =
    (majorMinor[0] ?? 0) > 22 ||
    ((majorMinor[0] ?? 0) === 22 && (majorMinor[1] ?? 0) >= 18);
  if (!nodeOk) {
    issues.push(
      `Node ${process.versions.node} is older than 22.18. Slim needs registerHooks (22.15+) and CJS sync-hook fixes (22.22.3+ recommended).`,
    );
  }
  const hooks = typeof registerHooks === "function";
  if (!hooks) issues.push("module.registerHooks is missing on this Node.");
  const gh = hasBin("gh");
  let typescript = false;
  try {
    const project = loadProject(cwd);
    const req = createRequire(project.packageJsonPath);
    req.resolve("typescript");
    typescript = true;
  } catch {
    issues.push("typescript is not installed in this project. npm i -D typescript");
  }
  let git = false;
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      stdio: "ignore",
    });
    git = true;
  } catch {
    issues.push("not a git work tree");
  }
  let lockfile: string | null = null;
  try {
    lockfile = loadProject(cwd).lockfile;
  } catch {
    issues.push("no package.json");
  }
  return {
    node: process.versions.node,
    nodeOk,
    registerHooks: hooks,
    gh,
    typescript,
    git,
    lockfile,
    issues,
  };
}

export async function runDoctor(args: CliArgs): Promise<number> {
  const report = collectDoctor();
  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(`node            ${report.node} ${report.nodeOk ? "ok" : "TOO OLD"}\n`);
    process.stdout.write(`registerHooks   ${report.registerHooks ? "yes" : "NO"}\n`);
    process.stdout.write(`gh              ${report.gh ? "yes" : "missing (PRs will be local-only)"}\n`);
    process.stdout.write(`typescript      ${report.typescript ? "yes" : "NO"}\n`);
    process.stdout.write(`git             ${report.git ? "yes" : "NO"}\n`);
    process.stdout.write(`lockfile        ${report.lockfile ?? "none"}\n`);
    if (report.issues.length) {
      process.stderr.write("\nissues:\n");
      for (const i of report.issues) process.stderr.write(`  - ${i}\n`);
    } else {
      process.stdout.write("\nready.\n");
    }
  }
  return report.nodeOk && report.registerHooks ? EXIT_OK : EXIT_ENV;
}
