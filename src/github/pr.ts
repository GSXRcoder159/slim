import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
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
  files: string[];
}

const PR_BODY_FIELDS: { name: string; re: RegExp }[] = [
  { name: "envelope hash", re: /Envelope hash:/i },
  { name: "package", re: /Package: / },
  { name: "symbols", re: /Symbols:/ },
  { name: "unknowns", re: /Unknowns:/ },
  { name: "coverage", re: /Coverage holes/i },
  { name: "fuzz seed", re: /seed:/i },
  { name: "fuzz disagreements", re: /disagreements:/i },
  { name: "fuzz cases", re: /cases:/i },
  { name: "size", re: /Byte delta/i },
  { name: "residual risk", re: /Residual risk/i },
  { name: "upstream pin", re: /Upstream pin/i },
  { name: "revert", re: /How to revert/i },
];

function defaultExecFile(
  file: string,
  args: readonly string[] = [],
  options?: ExecFileSyncOptions,
): string | Buffer {
  return execFileSync(file, [...args], options) as string | Buffer;
}

function errText(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { message?: string; stderr?: string | Buffer };
    const stderr = e.stderr ? String(e.stderr).trim() : "";
    if (stderr) return stderr;
    if (e.message) return e.message;
  }
  return String(err);
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
        stdio: ["ignore", "pipe", "ignore"],
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

function gitOut(execFile: ExecFileFn, root: string, args: readonly string[]): string {
  return String(execFile("git", args, { cwd: root, encoding: "utf8" })).trim();
}

function refExists(execFile: ExecFileFn, root: string, ref: string): boolean {
  try {
    execFile("git", ["show-ref", "--verify", "--quiet", ref], { cwd: root, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function normalizeFiles(files: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    const rel = f.replace(/\\/g, "/");
    if (!rel || rel.startsWith("/") || rel.split("/").includes("..")) {
      throw new SlimExit(EXIT_FAIL, `refusing to commit path outside the project: ${f}`);
    }
    if (!seen.has(rel)) {
      seen.add(rel);
      out.push(rel);
    }
  }
  return out;
}

export function assertPrBodyComplete(body: string): void {
  const missing = PR_BODY_FIELDS.filter((f) => !f.re.test(body)).map((f) => f.name);
  if (missing.length) {
    throw new SlimExit(EXIT_FAIL, `evidence.md missing required PR fields: ${missing.join(", ")}`);
  }
}

export function commitSlimBranch(
  opts: { root: string; branch: string; files: string[]; message: string },
  execFile: ExecFileFn,
): string {
  const files = normalizeFiles(opts.files);
  const indexFile = join(opts.root, ".git", `slim-index-${process.pid}-${Date.now()}`);
  const indexEnv = { ...process.env, GIT_INDEX_FILE: indexFile };
  try {
    execFile("git", ["read-tree", "HEAD"], { cwd: opts.root, env: indexEnv, encoding: "utf8" });
    execFile("git", ["add", "-f", "--", ...files], {
      cwd: opts.root,
      env: indexEnv,
      encoding: "utf8",
    });
    const treeFromIndex = String(
      execFile("git", ["write-tree"], { cwd: opts.root, env: indexEnv, encoding: "utf8" }),
    ).trim();
    const head = gitOut(execFile, opts.root, ["rev-parse", "HEAD"]);
    const commit = String(
      execFile("git", ["commit-tree", treeFromIndex, "-p", head, "-m", opts.message], {
        cwd: opts.root,
        encoding: "utf8",
      }),
    ).trim();
    execFile("git", ["branch", opts.branch, commit], { cwd: opts.root, encoding: "utf8" });
    return commit;
  } catch (err) {
    if (err instanceof SlimExit) throw err;
    throw new SlimExit(EXIT_FAIL, `git commit failed: ${errText(err)}`);
  } finally {
    try {
      if (existsSync(indexFile)) unlinkSync(indexFile);
    } catch {
      /* leftover index is tmp */
    }
  }
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
  if (!opts.files?.length) {
    throw new SlimExit(EXIT_FAIL, "no files to commit for pull request");
  }
  const execFile = deps.execFile ?? defaultExecFile;
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const hasGh = deps.hasGh ?? (() => detectHasGh(execFile));

  try {
    gitOut(execFile, opts.root, ["rev-parse", "--is-inside-work-tree"]);
  } catch (err) {
    throw new SlimExit(EXIT_ENV, `not a git repository: ${errText(err)}`);
  }

  if (refExists(execFile, opts.root, `refs/heads/${opts.branch}`)) {
    throw new SlimExit(
      EXIT_FAIL,
      `local branch ${opts.branch} already exists; refusing to overwrite`,
    );
  }

  let origin: string;
  try {
    origin = gitOut(execFile, opts.root, ["remote", "get-url", "origin"]);
  } catch (err) {
    throw new SlimExit(EXIT_ENV, `no origin remote; cannot open a pull request: ${errText(err)}`);
  }
  const { owner, repo } = parseGithubOwnerRepo(origin);

  const gh = hasGh();
  const token = gitToken(env);
  if (!gh && !token) {
    throw new SlimExit(
      EXIT_ENV,
      "GitHub CLI (gh) is not on PATH and GITHUB_TOKEN is not set. Install GitHub CLI or set GITHUB_TOKEN to open a pull request.",
    );
  }

  let remoteHeads = "";
  try {
    remoteHeads = gitOut(execFile, opts.root, [
      "ls-remote",
      "--heads",
      "origin",
      `refs/heads/${opts.branch}`,
    ]);
  } catch (err) {
    throw new SlimExit(EXIT_FAIL, `git ls-remote failed: ${errText(err)}`);
  }
  if (remoteHeads) {
    throw new SlimExit(
      EXIT_FAIL,
      `origin already has ${opts.branch}; refusing to overwrite`,
    );
  }

  const base = detectBaseBranch(execFile, opts.root);
  commitSlimBranch(
    { root: opts.root, branch: opts.branch, files: opts.files, message: opts.title },
    execFile,
  );

  try {
    execFile("git", ["push", "-u", "origin", `refs/heads/${opts.branch}:refs/heads/${opts.branch}`], {
      cwd: opts.root,
      encoding: "utf8",
    });
  } catch (err) {
    process.stderr.write(`git push failed: ${errText(err)}\n`);
    throw new SlimExit(EXIT_FAIL, `git push failed: ${errText(err)}`);
  }

  if (gh) {
    const ghArgs = [
      "pr",
      "create",
      "--repo",
      `${owner}/${repo}`,
      "--base",
      base,
      "--head",
      opts.branch,
      "--title",
      opts.title,
      "--body",
      opts.body,
    ];
    process.stderr.write(`gh ${ghArgs.join(" ")}\n`);
    try {
      const out = String(
        execFile("gh", ghArgs, {
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

  return createPullRequestRest(opts, {
    fetchImpl,
    token: token!,
    owner,
    repo,
    base,
  });
}

async function createPullRequestRest(
  opts: CreatePrOpts,
  ctx: {
    fetchImpl: typeof fetch;
    token: string;
    owner: string;
    repo: string;
    base: string;
  },
): Promise<PrResult> {
  const url = `https://api.github.com/repos/${ctx.owner}/${ctx.repo}/pulls`;
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
        base: ctx.base,
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
  let text: string;
  try {
    text = readFileSync(md, "utf8");
  } catch {
    throw new SlimExit(EXIT_FAIL, `missing ${md}`);
  }
  assertPrBodyComplete(text);
  return text;
}
