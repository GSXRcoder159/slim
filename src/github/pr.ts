import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface PrResult {
  url: string | null;
  local: boolean;
}

export function createPullRequest(opts: {
  root: string;
  title: string;
  body: string;
  branch: string;
}): PrResult {
  try {
    execFileSync("gh", ["--version"], { stdio: "ignore" });
  } catch {
    process.stderr.write("gh not on PATH; files written locally. Install GitHub CLI to open a PR.\n");
    return { url: null, local: true };
  }
  try {
    execFileSync("git", ["checkout", "-B", opts.branch], { cwd: opts.root, stdio: "inherit" });
    execFileSync("git", ["add", "-A"], { cwd: opts.root, stdio: "inherit" });
    execFileSync("git", ["status", "--porcelain"], { cwd: opts.root });
    execFileSync(
      "git",
      ["commit", "-m", opts.title],
      { cwd: opts.root, stdio: "inherit" },
    );
  } catch {
    /* commit may fail if nothing to commit or no user.email — still try pr */
  }
  try {
    execFileSync("git", ["push", "-u", "origin", opts.branch], { cwd: opts.root, stdio: "inherit" });
    const out = execFileSync(
      "gh",
      ["pr", "create", "--title", opts.title, "--body", opts.body],
      { cwd: opts.root, encoding: "utf8" },
    );
    const url = out.trim().split(/\s+/).find((t) => t.startsWith("http")) ?? out.trim();
    return { url, local: false };
  } catch (err) {
    process.stderr.write(`gh pr create failed: ${err instanceof Error ? err.message : err}\n`);
    return { url: null, local: true };
  }
}

export function prBodyFromEvidence(root: string, pkg: string): string {
  const md = join(root, ".slim", pkg, "evidence.md");
  try {
    return readFileSync(md, "utf8");
  } catch {
    return "EVIDENCE, NOT PROOF\n\nSlim replacement. See .slim/" + pkg + "/evidence.md\n";
  }
}
