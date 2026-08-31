import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT_ENV, EXIT_FAIL, SlimExit } from "../exit.ts";
import { readStamp } from "../release/digest.ts";
import { EXPECTED_PACKAGE_NAME } from "../release/identity.ts";
import { gitIdentEnv, gitRemoteEnv } from "./git-env.ts";
import { sourceErr, sourceOk, type SourceResult } from "../upstream/status.ts";
import {
  REPLACE_PR_LABELS,
  SHA256_HEX,
  UPSTREAM_PR_LABELS,
  assertCommitMatchesTransaction,
  assertPrMatchesTransaction,
  assertRemotePrMatchesTransaction,
  parsePullRequestNumber,
  withArtifactDigest,
  type PrKind,
  type RemotePrSnapshot,
} from "./pr-transaction.ts";

export { REPLACE_PR_LABELS, UPSTREAM_PR_LABELS } from "./pr-transaction.ts";

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
  packageRoot?: string;
}

export interface CreatePrOpts {
  root: string;
  title: string;
  body: string;
  branch: string;
  files: string[];
  labels: string[];
  kind?: PrKind;
  pkg?: string;
  artifactDigest?: string;
  base?: string;
}

const PR_BODY_FIELDS: { name: string; re: RegExp }[] = [
  { name: "envelope hash", re: /Envelope hash:/i },
  { name: "evidence hash", re: /Evidence hash:/i },
  { name: "module digest", re: /Module digest:/i },
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

const REST_HEADERS = {
  accept: "application/vnd.github+json",
  "content-type": "application/json",
  "user-agent": "slim",
} as const;

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
    s.match(/^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i) ||
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

export function slimPackageRoot(start = fileURLToPath(import.meta.url)): string {
  let dir = dirname(start);
  for (let i = 0; i < 10; i++) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const name = (JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string }).name;
        if (name === EXPECTED_PACKAGE_NAME) return dir;
      } catch {
        /* keep walking */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new SlimExit(EXIT_FAIL, "missing candidate artifact digest");
}

export function resolveArtifactDigest(
  opts: { artifactDigest?: string },
  env: NodeJS.ProcessEnv,
  packageRoot?: string,
): string {
  if (opts.artifactDigest !== undefined) {
    if (!SHA256_HEX.test(opts.artifactDigest)) {
      throw new SlimExit(EXIT_FAIL, "missing candidate artifact digest");
    }
    return opts.artifactDigest;
  }
  const fromEnv = env.SLIM_NPM_DIGEST;
  if (fromEnv !== undefined && fromEnv !== "") {
    if (!SHA256_HEX.test(fromEnv)) {
      throw new SlimExit(EXIT_FAIL, "missing candidate artifact digest");
    }
    return fromEnv;
  }
  const sha = readStamp(packageRoot ?? slimPackageRoot())?.sha256;
  if (sha && SHA256_HEX.test(sha)) return sha;
  throw new SlimExit(EXIT_FAIL, "missing candidate artifact digest");
}

export function probeGithubAvailability(root: string, deps: PrDeps = {}): SourceResult<true> {
  const execFile = deps.execFile ?? defaultExecFile;
  const env = deps.env ?? process.env;
  const hasGh = deps.hasGh ?? (() => detectHasGh(execFile));
  try {
    gitOut(execFile, root, ["rev-parse", "--is-inside-work-tree"], env);
  } catch (err) {
    return sourceErr("unavailable", `not a git repository: ${errText(err)}`);
  }
  let origin: string;
  try {
    origin = gitOut(execFile, root, ["remote", "get-url", "origin"], env);
  } catch (err) {
    return sourceErr("unavailable", `no origin remote: ${errText(err)}`);
  }
  try {
    parseGithubOwnerRepo(origin);
  } catch (err) {
    return sourceErr("malformed", err instanceof Error ? err.message : String(err));
  }
  if (!hasGh() && !gitToken(env)) {
    return sourceErr(
      "unavailable",
      "GitHub CLI (gh) is not on PATH and GITHUB_TOKEN is not set",
    );
  }
  return sourceOk(true);
}

function gitOut(
  execFile: ExecFileFn,
  root: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): string {
  return String(execFile("git", args, { cwd: root, encoding: "utf8", env: gitRemoteEnv(env) })).trim();
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
  env: NodeJS.ProcessEnv = process.env,
): string {
  const files = normalizeFiles(opts.files);
  const indexFile = join(opts.root, ".git", `slim-index-${process.pid}-${Date.now()}`);
  const indexEnv = gitIdentEnv({ ...env, GIT_INDEX_FILE: indexFile });
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
    const head = gitOut(execFile, opts.root, ["rev-parse", "HEAD"], env);
    const commit = String(
      execFile("git", ["commit-tree", treeFromIndex, "-p", head, "-m", opts.message], {
        cwd: opts.root,
        encoding: "utf8",
        env: gitIdentEnv(env),
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

function abandonSlimRef(
  execFile: ExecFileFn,
  root: string,
  branch: string,
  remote: boolean,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (remote) {
    try {
      execFile("git", ["push", "origin", "--delete", branch], {
        cwd: root,
        encoding: "utf8",
        env: gitRemoteEnv(env),
      });
    } catch {
      /* still drop the local ref */
    }
  }
  try {
    execFile("git", ["branch", "-D", branch], { cwd: root, encoding: "utf8" });
  } catch {
    /* already gone */
  }
}

function dropVerifyRef(execFile: ExecFileFn, root: string, verifyRef: string): void {
  try {
    execFile("git", ["update-ref", "-d", verifyRef], { cwd: root, encoding: "utf8" });
  } catch {
    /* leftover verify ref is tmp */
  }
}

function ensureGhLabels(execFile: ExecFileFn, root: string, labels: string[]): void {
  for (const name of labels) {
    try {
      execFile("gh", ["label", "create", name, "--force"], { cwd: root, encoding: "utf8" });
    } catch {
      /* --force still fails if the repo cannot create labels; apply may work */
    }
  }
}

function authHeaders(token: string): Record<string, string> {
  return { ...REST_HEADERS, authorization: `Bearer ${token}` };
}

async function ensureRestLabels(
  fetchImpl: typeof fetch,
  token: string,
  owner: string,
  repo: string,
  labels: string[],
): Promise<void> {
  for (const name of labels) {
    const res = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}/labels`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ name }),
    });
    if (!res.ok && res.status !== 422) {
      const text = await res.text();
      throw new SlimExit(EXIT_FAIL, `GitHub REST label create failed: ${res.status} ${text.slice(0, 200)}`);
    }
  }
}

async function applyRestLabels(
  fetchImpl: typeof fetch,
  token: string,
  owner: string,
  repo: string,
  issue: number,
  labels: string[],
): Promise<void> {
  const res = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}/issues/${issue}/labels`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ labels }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new SlimExit(EXIT_FAIL, `GitHub REST label apply failed: ${res.status} ${text.slice(0, 200)}`);
  }
}

async function closePullRequest(
  execFile: ExecFileFn,
  fetchImpl: typeof fetch,
  token: string | undefined,
  gh: boolean,
  owner: string,
  repo: string,
  number: number | null,
  root: string,
): Promise<void> {
  if (number == null) return;
  if (token) {
    try {
      await fetchImpl(`https://api.github.com/repos/${owner}/${repo}/pulls/${number}`, {
        method: "PATCH",
        headers: authHeaders(token),
        body: JSON.stringify({ state: "closed" }),
      });
    } catch {
      /* still delete the Slim branch */
    }
    return;
  }
  if (gh) {
    try {
      execFile("gh", ["pr", "close", String(number), "--repo", `${owner}/${repo}`], {
        cwd: root,
        encoding: "utf8",
      });
    } catch {
      /* still delete the Slim branch */
    }
  }
}

function parseLsRemoteSha(out: string, branch: string): string {
  const line = out.trim().split("\n").find((l) => l.includes(`refs/heads/${branch}`)) ?? "";
  const m = line.match(/^([0-9a-f]{40})\s+refs\/heads\/\S+/);
  if (!m?.[1]) {
    throw new SlimExit(EXIT_FAIL, `origin ${branch} SHA does not match the Slim commit`);
  }
  return m[1];
}

function restStatusMessage(action: string, status: number): string {
  if (status === 401 || status === 403) {
    return `GitHub REST ${action} failed: ${status} authentication`;
  }
  return `GitHub REST ${action} failed: ${status}`;
}

async function readRemotePrRest(
  fetchImpl: typeof fetch,
  token: string,
  owner: string,
  repo: string,
  number: number,
): Promise<RemotePrSnapshot> {
  const pullRes = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}/pulls/${number}`, {
    method: "GET",
    headers: authHeaders(token),
  });
  if (!pullRes.ok) {
    throw new SlimExit(EXIT_FAIL, restStatusMessage("PR read", pullRes.status));
  }
  const pull = (await pullRes.json()) as {
    html_url?: string;
    title?: string;
    body?: string | null;
    base?: { ref?: string };
    head?: { ref?: string; sha?: string };
  };
  const filesRes = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}/pulls/${number}/files`, {
    method: "GET",
    headers: authHeaders(token),
  });
  if (!filesRes.ok) {
    throw new SlimExit(EXIT_FAIL, restStatusMessage("PR files read", filesRes.status));
  }
  const filesJson = (await filesRes.json()) as { filename?: string }[];
  const labelsRes = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}/issues/${number}/labels`, {
    method: "GET",
    headers: authHeaders(token),
  });
  if (!labelsRes.ok) {
    throw new SlimExit(EXIT_FAIL, restStatusMessage("PR labels read", labelsRes.status));
  }
  const labelsJson = (await labelsRes.json()) as { name?: string }[];
  if (!pull.html_url || !pull.title || !pull.head?.sha || !pull.head.ref || !pull.base?.ref) {
    throw new SlimExit(EXIT_FAIL, "GitHub REST PR read returned an incomplete document");
  }
  return {
    url: pull.html_url,
    title: pull.title,
    body: pull.body ?? "",
    base: pull.base.ref,
    head: pull.head.ref,
    headSha: pull.head.sha,
    labels: labelsJson.map((l) => l.name).filter((n): n is string => Boolean(n)),
    files: filesJson.map((f) => f.filename).filter((n): n is string => Boolean(n)),
  };
}

function readRemotePrGh(
  execFile: ExecFileFn,
  root: string,
  owner: string,
  repo: string,
  number: number,
): RemotePrSnapshot {
  const raw = String(
    execFile(
      "gh",
      [
        "pr",
        "view",
        String(number),
        "--repo",
        `${owner}/${repo}`,
        "--json",
        "title,body,baseRefName,headRefName,labels,files,headRefOid,url",
      ],
      { cwd: root, encoding: "utf8" },
    ),
  );
  let parsed: {
    title?: string;
    body?: string;
    baseRefName?: string;
    headRefName?: string;
    labels?: { name?: string }[];
    files?: { path?: string }[];
    headRefOid?: string;
    url?: string;
  };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    throw new SlimExit(EXIT_FAIL, "gh pr view returned malformed JSON");
  }
  if (!parsed.url || !parsed.title || !parsed.headRefOid || !parsed.headRefName || !parsed.baseRefName) {
    throw new SlimExit(EXIT_FAIL, "gh pr view returned an incomplete document");
  }
  return {
    url: parsed.url,
    title: parsed.title,
    body: parsed.body ?? "",
    base: parsed.baseRefName,
    head: parsed.headRefName,
    headSha: parsed.headRefOid,
    labels: (parsed.labels ?? []).map((l) => l.name).filter((n): n is string => Boolean(n)),
    files: (parsed.files ?? []).map((f) => f.path).filter((n): n is string => Boolean(n)),
  };
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
  if (!opts.labels?.length) {
    throw new SlimExit(EXIT_FAIL, "PR labels must match the accepted transaction");
  }
  const kind = opts.kind ?? (opts.branch === "slim/upstream" || opts.labels.includes("slim:upstream")
    ? "upstream"
    : "replace");
  if (kind === "replace") assertPrBodyComplete(opts.body);

  const execFile = deps.execFile ?? defaultExecFile;
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const hasGh = deps.hasGh ?? (() => detectHasGh(execFile));

  try {
    gitOut(execFile, opts.root, ["rev-parse", "--is-inside-work-tree"], env);
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
    origin = gitOut(execFile, opts.root, ["remote", "get-url", "origin"], env);
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

  const digest = resolveArtifactDigest(opts, env, deps.packageRoot);
  const body = withArtifactDigest(opts.body, digest);

  let remoteHeads = "";
  try {
    remoteHeads = gitOut(
      execFile,
      opts.root,
      ["ls-remote", "--heads", "origin", `refs/heads/${opts.branch}`],
      env,
    );
  } catch (err) {
    throw new SlimExit(EXIT_FAIL, `git ls-remote failed: ${errText(err)}`);
  }
  if (remoteHeads) {
    throw new SlimExit(
      EXIT_FAIL,
      `origin already has ${opts.branch}; refusing to overwrite`,
    );
  }

  const detectedBase = detectBaseBranch(execFile, opts.root);
  if (opts.base && opts.base !== detectedBase) {
    throw new SlimExit(EXIT_FAIL, `PR base ${opts.base} does not match ${detectedBase}`);
  }
  const base = detectedBase;
  assertPrMatchesTransaction({ ...opts, kind, body, artifactDigest: digest, base });

  const head = gitOut(execFile, opts.root, ["rev-parse", "HEAD"], env);
  const sha = commitSlimBranch(
    { root: opts.root, branch: opts.branch, files: opts.files, message: opts.title },
    execFile,
    env,
  );
  assertCommitMatchesTransaction(
    (args) => gitOut(execFile, opts.root, args, env),
    sha,
    opts.files,
    opts.title,
    head,
  );

  try {
    execFile("git", ["push", "-u", "origin", `refs/heads/${opts.branch}:refs/heads/${opts.branch}`], {
      cwd: opts.root,
      encoding: "utf8",
      env: gitRemoteEnv(env),
    });
  } catch (err) {
    abandonSlimRef(execFile, opts.root, opts.branch, false, env);
    process.stderr.write(`git push failed: ${errText(err)}\n`);
    throw new SlimExit(EXIT_FAIL, `git push failed: ${errText(err)}`);
  }

  try {
    const landed = gitOut(
      execFile,
      opts.root,
      ["ls-remote", "--heads", "origin", `refs/heads/${opts.branch}`],
      env,
    );
    const remoteSha = parseLsRemoteSha(landed, opts.branch);
    if (remoteSha !== sha) {
      throw new SlimExit(EXIT_FAIL, `origin ${opts.branch} SHA does not match the Slim commit`);
    }
  } catch (err) {
    abandonSlimRef(execFile, opts.root, opts.branch, true, env);
    if (err instanceof SlimExit) throw err;
    throw new SlimExit(EXIT_FAIL, `origin ${opts.branch} SHA does not match the Slim commit`);
  }

  const accepted = {
    ...opts,
    kind,
    body,
    artifactDigest: digest,
    base,
  };
  let prNumber: number | null = null;
  const verifyRef = `refs/slim-verify/${process.pid}-${Date.now()}`;
  try {
    let url: string;
    if (gh) {
      ensureGhLabels(execFile, opts.root, opts.labels);
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
        body,
        ...opts.labels.flatMap((l) => ["--label", l]),
      ];
      process.stderr.write(`gh ${ghArgs.join(" ")}\n`);
      try {
        const out = String(
          execFile("gh", ghArgs, {
            cwd: opts.root,
            encoding: "utf8",
          }),
        );
        url = out.trim().split(/\s+/).find((t) => t.startsWith("http")) ?? out.trim();
      } catch (err) {
        process.stderr.write(`gh pr create failed: ${errText(err)}\n`);
        throw new SlimExit(EXIT_FAIL, `gh pr create failed: ${errText(err)}`);
      }
    } else {
      const created = await createPullRequestRest(accepted, {
        fetchImpl,
        token: token!,
        owner,
        repo,
        base,
      });
      url = created.url;
      prNumber = created.number;
    }
    prNumber = prNumber ?? parsePullRequestNumber(url);

    try {
      gitOut(execFile, opts.root, ["fetch", "origin", `refs/heads/${opts.branch}:${verifyRef}`], env);
      const fetched = gitOut(execFile, opts.root, ["rev-parse", verifyRef], env);
      if (fetched !== sha) {
        throw new SlimExit(EXIT_FAIL, `origin ${opts.branch} SHA does not match the Slim commit`);
      }
      assertCommitMatchesTransaction(
        (args) => gitOut(execFile, opts.root, args, env),
        fetched,
        opts.files,
        opts.title,
        head,
      );
    } finally {
      dropVerifyRef(execFile, opts.root, verifyRef);
    }

    const remote = token
      ? await readRemotePrRest(fetchImpl, token, owner, repo, prNumber)
      : readRemotePrGh(execFile, opts.root, owner, repo, prNumber);
    assertRemotePrMatchesTransaction(remote, {
      title: opts.title,
      body,
      base,
      branch: opts.branch,
      sha,
      labels: opts.labels,
      files: opts.files,
    });
    return { url: remote.url, local: false };
  } catch (err) {
    dropVerifyRef(execFile, opts.root, verifyRef);
    await closePullRequest(execFile, fetchImpl, token, gh, owner, repo, prNumber, opts.root);
    abandonSlimRef(execFile, opts.root, opts.branch, true, env);
    if (err instanceof SlimExit) throw err;
    throw new SlimExit(EXIT_FAIL, `pull request failed: ${errText(err)}`);
  }
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
): Promise<{ url: string; number: number }> {
  await ensureRestLabels(ctx.fetchImpl, ctx.token, ctx.owner, ctx.repo, opts.labels);
  const url = `https://api.github.com/repos/${ctx.owner}/${ctx.repo}/pulls`;
  try {
    const res = await ctx.fetchImpl(url, {
      method: "POST",
      headers: authHeaders(ctx.token),
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
      throw new SlimExit(EXIT_FAIL, restStatusMessage("PR create", res.status));
    }
    const json = (await res.json()) as { html_url?: string; number?: number };
    if (json.number == null || !json.html_url) {
      throw new SlimExit(EXIT_FAIL, "GitHub REST PR create returned no issue number");
    }
    await applyRestLabels(ctx.fetchImpl, ctx.token, ctx.owner, ctx.repo, json.number, opts.labels);
    return { url: json.html_url, number: json.number };
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
