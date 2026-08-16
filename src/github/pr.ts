import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT_ENV, EXIT_FAIL, SlimExit } from "../exit.ts";

export interface PrResult {
  url: string | null;
  local: boolean;
}

export type ExecFileFn = (
  file: string,
  args?: readonly string[],
  options?: ExecFileSyncOptions,
) => string | Buffer;

export interface PrDeps {
  hasGh?: () => boolean;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  execFile?: ExecFileFn;
}

export interface CreatePrOpts {
  root: string;
  title: string;
  body: string;
  branch: string;
}

function defaultExecFile(
  file: string,
  args: readonly string[] = [],
  options?: ExecFileSyncOptions,
): string | Buffer {
  return execFileSync(file, [...args], options) as string | Buffer;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function parseGithubOwnerRepo(remoteUrl: string): { owner: string; repo: string } {
  const s = remoteUrl.trim();
  const m =
    s.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i) ||
    s.match(/^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i) ||
    s.match(/^https?:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (!m) {
    throw new SlimExit(EXIT_ENV, `cannot parse GitHub owner/repo from origin: ${s}`);
  }
  return { owner: m[1]!, repo: m[2]! };
}

function detectHasGh(execFile: ExecFileFn): boolean {
  try {
    execFile("gh", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function detectBaseBranch(execFile: ExecFileFn, root: string): string {
  try {
    const ref = String(
      execFile("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
        cwd: root,
        encoding: "utf8",
      }),
    ).trim();
    const m = ref.match(/refs\/remotes\/origin\/(.+)$/);
    if (m?.[1]) return m[1];
  } catch {
    /* default */
  }
  return "main";
}

function gitToken(env: NodeJS.ProcessEnv): string | undefined {
  return env.GITHUB_TOKEN || env.GH_TOKEN || undefined;
}

export async function maybeCreatePullRequest(
  requested: boolean,
  opts: CreatePrOpts,
  deps: PrDeps = {},
): Promise<PrResult | null> {
  if (!requested) return null;
  return createPullRequest(opts, deps);
}

export async function createPullRequest(opts: CreatePrOpts, deps: PrDeps = {}): Promise<PrResult> {
  const execFile = deps.execFile ?? defaultExecFile;
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const hasGh = deps.hasGh ?? (() => detectHasGh(execFile));

  try {
    execFile("git", ["checkout", "-B", opts.branch], { cwd: opts.root, stdio: "inherit" });
    execFile("git", ["add", "-A"], { cwd: opts.root, stdio: "inherit" });
  } catch (err) {
    process.stderr.write(`git prepare failed: ${errText(err)}\n`);
  }
  try {
    execFile("git", ["commit", "-m", opts.title], { cwd: opts.root, stdio: "inherit" });
  } catch (err) {
    process.stderr.write(`git commit failed: ${errText(err)}\n`);
  }

  const gh = hasGh();
  const token = gitToken(env);
  if (!gh && !token) {
    throw new SlimExit(
      EXIT_ENV,
      "GitHub CLI (gh) is not on PATH and GITHUB_TOKEN is not set. Install GitHub CLI or set GITHUB_TOKEN to open a pull request.",
    );
  }

  try {
    execFile("git", ["push", "-u", "origin", opts.branch], { cwd: opts.root, stdio: "inherit" });
  } catch (err) {
    process.stderr.write(`git push failed: ${errText(err)}\n`);
    throw new SlimExit(EXIT_FAIL, `git push failed: ${errText(err)}`);
  }

  if (gh) {
    const invocation = `gh pr create --title ${opts.title} --body ${opts.body}`;
    process.stderr.write(invocation + "\n");
    try {
      const out = String(
        execFile("gh", ["pr", "create", "--title", opts.title, "--body", opts.body], {
          cwd: opts.root,
          encoding: "utf8",
        }),
      );
      const url = out.trim().split(/\s+/).find((t) => t.startsWith("http")) ?? out.trim();
      return { url, local: false };
    } catch (err) {
      process.stderr.write(`gh pr create failed: ${errText(err)}\n`);
      throw new SlimExit(EXIT_FAIL, `gh pr create failed: ${errText(err)}`);
    }
  }

  return createPullRequestRest(opts, { execFile, fetchImpl, token: token! });
}

async function createPullRequestRest(
  opts: CreatePrOpts,
  ctx: { execFile: ExecFileFn; fetchImpl: typeof fetch; token: string },
): Promise<PrResult> {
  let origin: string;
  try {
    origin = String(
      ctx.execFile("git", ["remote", "get-url", "origin"], { cwd: opts.root, encoding: "utf8" }),
    ).trim();
  } catch (err) {
    process.stderr.write(`git remote get-url origin failed: ${errText(err)}\n`);
    throw new SlimExit(EXIT_FAIL, `git remote get-url origin failed: ${errText(err)}`);
  }
  const { owner, repo } = parseGithubOwnerRepo(origin);
  const base = detectBaseBranch(ctx.execFile, opts.root);
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls`;
  try {
    const res = await ctx.fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ctx.token}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "user-agent": "slim",
      },
      body: JSON.stringify({
        title: opts.title,
        body: opts.body,
        head: opts.branch,
        base,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      process.stderr.write(`GitHub REST PR create failed: ${res.status} ${text.slice(0, 400)}\n`);
      throw new SlimExit(EXIT_FAIL, `GitHub REST PR create failed: ${res.status}`);
    }
    const json = (await res.json()) as { html_url?: string };
    return { url: json.html_url ?? null, local: false };
  } catch (err) {
    if (err instanceof SlimExit) throw err;
    process.stderr.write(`GitHub REST PR create failed: ${errText(err)}\n`);
    throw new SlimExit(EXIT_FAIL, `GitHub REST PR create failed: ${errText(err)}`);
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
