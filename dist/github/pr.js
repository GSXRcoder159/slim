import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT_ENV, EXIT_FAIL, SlimExit } from "../exit.js";
import { readStamp } from "../release/digest.js";
import { sourceErr, sourceOk } from "../upstream/status.js";
import { REPLACE_PR_LABELS, SHA256_HEX, UPSTREAM_PR_LABELS, assertCommitMatchesTransaction, assertPrMatchesTransaction, assertRemotePrMatchesTransaction, parsePullRequestNumber, withArtifactDigest, } from "./pr-transaction.js";
export { REPLACE_PR_LABELS, UPSTREAM_PR_LABELS } from "./pr-transaction.js";
const PR_BODY_FIELDS = [
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
};
function defaultExecFile(file, args = [], options) {
    return execFileSync(file, [...args], options);
}
function errText(err) {
    if (err && typeof err === "object") {
        const e = err;
        const stderr = e.stderr ? String(e.stderr).trim() : "";
        if (stderr)
            return stderr;
        if (e.message)
            return e.message;
    }
    return String(err);
}
export function parseGithubOwnerRepo(remoteUrl) {
    const s = remoteUrl.trim();
    const m = s.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i) ||
        s.match(/^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i) ||
        s.match(/^https?:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
    if (!m) {
        throw new SlimExit(EXIT_ENV, `cannot parse GitHub owner/repo from origin: ${s}`);
    }
    return { owner: m[1], repo: m[2] };
}
function detectHasGh(execFile) {
    try {
        execFile("gh", ["--version"], { stdio: "ignore" });
        return true;
    }
    catch {
        return false;
    }
}
function detectBaseBranch(execFile, root) {
    try {
        const ref = String(execFile("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
            cwd: root,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        })).trim();
        const m = ref.match(/refs\/remotes\/origin\/(.+)$/);
        if (m?.[1])
            return m[1];
    }
    catch {
        /* default */
    }
    return "main";
}
function gitToken(env) {
    return env.GITHUB_TOKEN || env.GH_TOKEN || undefined;
}
export function slimPackageRoot(start = fileURLToPath(import.meta.url)) {
    let dir = dirname(start);
    for (let i = 0; i < 10; i++) {
        const pkgPath = join(dir, "package.json");
        if (existsSync(pkgPath)) {
            try {
                const name = JSON.parse(readFileSync(pkgPath, "utf8")).name;
                if (name === "slim")
                    return dir;
            }
            catch {
                /* keep walking */
            }
        }
        const parent = dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
    throw new SlimExit(EXIT_FAIL, "missing candidate artifact digest");
}
export function resolveArtifactDigest(opts, env, packageRoot) {
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
    if (sha && SHA256_HEX.test(sha))
        return sha;
    throw new SlimExit(EXIT_FAIL, "missing candidate artifact digest");
}
export function probeGithubAvailability(root, deps = {}) {
    const execFile = deps.execFile ?? defaultExecFile;
    const env = deps.env ?? process.env;
    const hasGh = deps.hasGh ?? (() => detectHasGh(execFile));
    try {
        gitOut(execFile, root, ["rev-parse", "--is-inside-work-tree"]);
    }
    catch (err) {
        return sourceErr("unavailable", `not a git repository: ${errText(err)}`);
    }
    let origin;
    try {
        origin = gitOut(execFile, root, ["remote", "get-url", "origin"]);
    }
    catch (err) {
        return sourceErr("unavailable", `no origin remote: ${errText(err)}`);
    }
    try {
        parseGithubOwnerRepo(origin);
    }
    catch (err) {
        return sourceErr("malformed", err instanceof Error ? err.message : String(err));
    }
    if (!hasGh() && !gitToken(env)) {
        return sourceErr("unavailable", "GitHub CLI (gh) is not on PATH and GITHUB_TOKEN is not set");
    }
    return sourceOk(true);
}
function gitOut(execFile, root, args) {
    return String(execFile("git", args, { cwd: root, encoding: "utf8" })).trim();
}
function refExists(execFile, root, ref) {
    try {
        execFile("git", ["show-ref", "--verify", "--quiet", ref], { cwd: root, stdio: "ignore" });
        return true;
    }
    catch {
        return false;
    }
}
function normalizeFiles(files) {
    const out = [];
    const seen = new Set();
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
export function assertPrBodyComplete(body) {
    const missing = PR_BODY_FIELDS.filter((f) => !f.re.test(body)).map((f) => f.name);
    if (missing.length) {
        throw new SlimExit(EXIT_FAIL, `evidence.md missing required PR fields: ${missing.join(", ")}`);
    }
}
export function commitSlimBranch(opts, execFile) {
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
        const treeFromIndex = String(execFile("git", ["write-tree"], { cwd: opts.root, env: indexEnv, encoding: "utf8" })).trim();
        const head = gitOut(execFile, opts.root, ["rev-parse", "HEAD"]);
        const commit = String(execFile("git", ["commit-tree", treeFromIndex, "-p", head, "-m", opts.message], {
            cwd: opts.root,
            encoding: "utf8",
        })).trim();
        execFile("git", ["branch", opts.branch, commit], { cwd: opts.root, encoding: "utf8" });
        return commit;
    }
    catch (err) {
        if (err instanceof SlimExit)
            throw err;
        throw new SlimExit(EXIT_FAIL, `git commit failed: ${errText(err)}`);
    }
    finally {
        try {
            if (existsSync(indexFile))
                unlinkSync(indexFile);
        }
        catch {
            /* leftover index is tmp */
        }
    }
}
function abandonSlimRef(execFile, root, branch, remote) {
    if (remote) {
        try {
            execFile("git", ["push", "origin", "--delete", branch], { cwd: root, encoding: "utf8" });
        }
        catch {
            /* still drop the local ref */
        }
    }
    try {
        execFile("git", ["branch", "-D", branch], { cwd: root, encoding: "utf8" });
    }
    catch {
        /* already gone */
    }
}
function dropVerifyRef(execFile, root, verifyRef) {
    try {
        execFile("git", ["update-ref", "-d", verifyRef], { cwd: root, encoding: "utf8" });
    }
    catch {
        /* leftover verify ref is tmp */
    }
}
function ensureGhLabels(execFile, root, labels) {
    for (const name of labels) {
        try {
            execFile("gh", ["label", "create", name, "--force"], { cwd: root, encoding: "utf8" });
        }
        catch {
            /* --force still fails if the repo cannot create labels; apply may work */
        }
    }
}
function authHeaders(token) {
    return { ...REST_HEADERS, authorization: `Bearer ${token}` };
}
async function ensureRestLabels(fetchImpl, token, owner, repo, labels) {
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
async function applyRestLabels(fetchImpl, token, owner, repo, issue, labels) {
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
async function closePullRequest(execFile, fetchImpl, token, gh, owner, repo, number, root) {
    if (number == null)
        return;
    if (token) {
        try {
            await fetchImpl(`https://api.github.com/repos/${owner}/${repo}/pulls/${number}`, {
                method: "PATCH",
                headers: authHeaders(token),
                body: JSON.stringify({ state: "closed" }),
            });
        }
        catch {
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
        }
        catch {
            /* still delete the Slim branch */
        }
    }
}
function parseLsRemoteSha(out, branch) {
    const line = out.trim().split("\n").find((l) => l.includes(`refs/heads/${branch}`)) ?? "";
    const m = line.match(/^([0-9a-f]{40})\s+refs\/heads\/\S+/);
    if (!m?.[1]) {
        throw new SlimExit(EXIT_FAIL, `origin ${branch} SHA does not match the Slim commit`);
    }
    return m[1];
}
function restStatusMessage(action, status) {
    if (status === 401 || status === 403) {
        return `GitHub REST ${action} failed: ${status} authentication`;
    }
    return `GitHub REST ${action} failed: ${status}`;
}
async function readRemotePrRest(fetchImpl, token, owner, repo, number) {
    const pullRes = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}/pulls/${number}`, {
        method: "GET",
        headers: authHeaders(token),
    });
    if (!pullRes.ok) {
        throw new SlimExit(EXIT_FAIL, restStatusMessage("PR read", pullRes.status));
    }
    const pull = (await pullRes.json());
    const filesRes = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}/pulls/${number}/files`, {
        method: "GET",
        headers: authHeaders(token),
    });
    if (!filesRes.ok) {
        throw new SlimExit(EXIT_FAIL, restStatusMessage("PR files read", filesRes.status));
    }
    const filesJson = (await filesRes.json());
    const labelsRes = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}/issues/${number}/labels`, {
        method: "GET",
        headers: authHeaders(token),
    });
    if (!labelsRes.ok) {
        throw new SlimExit(EXIT_FAIL, restStatusMessage("PR labels read", labelsRes.status));
    }
    const labelsJson = (await labelsRes.json());
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
        labels: labelsJson.map((l) => l.name).filter((n) => Boolean(n)),
        files: filesJson.map((f) => f.filename).filter((n) => Boolean(n)),
    };
}
function readRemotePrGh(execFile, root, owner, repo, number) {
    const raw = String(execFile("gh", [
        "pr",
        "view",
        String(number),
        "--repo",
        `${owner}/${repo}`,
        "--json",
        "title,body,baseRefName,headRefName,labels,files,headRefOid,url",
    ], { cwd: root, encoding: "utf8" }));
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
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
        labels: (parsed.labels ?? []).map((l) => l.name).filter((n) => Boolean(n)),
        files: (parsed.files ?? []).map((f) => f.path).filter((n) => Boolean(n)),
    };
}
export async function maybeCreatePullRequest(requested, opts, deps = {}) {
    if (!requested)
        return null;
    return createPullRequest(opts, deps);
}
export async function createPullRequest(opts, deps = {}) {
    if (!opts.files?.length) {
        throw new SlimExit(EXIT_FAIL, "no files to commit for pull request");
    }
    if (!opts.labels?.length) {
        throw new SlimExit(EXIT_FAIL, "PR labels must match the accepted transaction");
    }
    const kind = opts.kind ?? (opts.branch === "slim/upstream" || opts.labels.includes("slim:upstream")
        ? "upstream"
        : "replace");
    if (kind === "replace")
        assertPrBodyComplete(opts.body);
    const execFile = deps.execFile ?? defaultExecFile;
    const env = deps.env ?? process.env;
    const fetchImpl = deps.fetchImpl ?? fetch;
    const hasGh = deps.hasGh ?? (() => detectHasGh(execFile));
    try {
        gitOut(execFile, opts.root, ["rev-parse", "--is-inside-work-tree"]);
    }
    catch (err) {
        throw new SlimExit(EXIT_ENV, `not a git repository: ${errText(err)}`);
    }
    if (refExists(execFile, opts.root, `refs/heads/${opts.branch}`)) {
        throw new SlimExit(EXIT_FAIL, `local branch ${opts.branch} already exists; refusing to overwrite`);
    }
    let origin;
    try {
        origin = gitOut(execFile, opts.root, ["remote", "get-url", "origin"]);
    }
    catch (err) {
        throw new SlimExit(EXIT_ENV, `no origin remote; cannot open a pull request: ${errText(err)}`);
    }
    const { owner, repo } = parseGithubOwnerRepo(origin);
    const gh = hasGh();
    const token = gitToken(env);
    if (!gh && !token) {
        throw new SlimExit(EXIT_ENV, "GitHub CLI (gh) is not on PATH and GITHUB_TOKEN is not set. Install GitHub CLI or set GITHUB_TOKEN to open a pull request.");
    }
    const digest = resolveArtifactDigest(opts, env, deps.packageRoot);
    const body = withArtifactDigest(opts.body, digest);
    let remoteHeads = "";
    try {
        remoteHeads = gitOut(execFile, opts.root, [
            "ls-remote",
            "--heads",
            "origin",
            `refs/heads/${opts.branch}`,
        ]);
    }
    catch (err) {
        throw new SlimExit(EXIT_FAIL, `git ls-remote failed: ${errText(err)}`);
    }
    if (remoteHeads) {
        throw new SlimExit(EXIT_FAIL, `origin already has ${opts.branch}; refusing to overwrite`);
    }
    const detectedBase = detectBaseBranch(execFile, opts.root);
    if (opts.base && opts.base !== detectedBase) {
        throw new SlimExit(EXIT_FAIL, `PR base ${opts.base} does not match ${detectedBase}`);
    }
    const base = detectedBase;
    assertPrMatchesTransaction({ ...opts, kind, body, artifactDigest: digest, base });
    const head = gitOut(execFile, opts.root, ["rev-parse", "HEAD"]);
    const sha = commitSlimBranch({ root: opts.root, branch: opts.branch, files: opts.files, message: opts.title }, execFile);
    assertCommitMatchesTransaction((args) => gitOut(execFile, opts.root, args), sha, opts.files, opts.title, head);
    try {
        execFile("git", ["push", "-u", "origin", `refs/heads/${opts.branch}:refs/heads/${opts.branch}`], {
            cwd: opts.root,
            encoding: "utf8",
        });
    }
    catch (err) {
        abandonSlimRef(execFile, opts.root, opts.branch, false);
        process.stderr.write(`git push failed: ${errText(err)}\n`);
        throw new SlimExit(EXIT_FAIL, `git push failed: ${errText(err)}`);
    }
    try {
        const landed = gitOut(execFile, opts.root, [
            "ls-remote",
            "--heads",
            "origin",
            `refs/heads/${opts.branch}`,
        ]);
        const remoteSha = parseLsRemoteSha(landed, opts.branch);
        if (remoteSha !== sha) {
            throw new SlimExit(EXIT_FAIL, `origin ${opts.branch} SHA does not match the Slim commit`);
        }
    }
    catch (err) {
        abandonSlimRef(execFile, opts.root, opts.branch, true);
        if (err instanceof SlimExit)
            throw err;
        throw new SlimExit(EXIT_FAIL, `origin ${opts.branch} SHA does not match the Slim commit`);
    }
    const accepted = {
        ...opts,
        kind,
        body,
        artifactDigest: digest,
        base,
    };
    let prNumber = null;
    const verifyRef = `refs/slim-verify/${process.pid}-${Date.now()}`;
    try {
        let url;
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
                const out = String(execFile("gh", ghArgs, {
                    cwd: opts.root,
                    encoding: "utf8",
                }));
                url = out.trim().split(/\s+/).find((t) => t.startsWith("http")) ?? out.trim();
            }
            catch (err) {
                process.stderr.write(`gh pr create failed: ${errText(err)}\n`);
                throw new SlimExit(EXIT_FAIL, `gh pr create failed: ${errText(err)}`);
            }
        }
        else {
            const created = await createPullRequestRest(accepted, {
                fetchImpl,
                token: token,
                owner,
                repo,
                base,
            });
            url = created.url;
            prNumber = created.number;
        }
        prNumber = prNumber ?? parsePullRequestNumber(url);
        try {
            gitOut(execFile, opts.root, ["fetch", "origin", `refs/heads/${opts.branch}:${verifyRef}`]);
            const fetched = gitOut(execFile, opts.root, ["rev-parse", verifyRef]);
            if (fetched !== sha) {
                throw new SlimExit(EXIT_FAIL, `origin ${opts.branch} SHA does not match the Slim commit`);
            }
            assertCommitMatchesTransaction((args) => gitOut(execFile, opts.root, args), fetched, opts.files, opts.title, head);
        }
        finally {
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
    }
    catch (err) {
        dropVerifyRef(execFile, opts.root, verifyRef);
        await closePullRequest(execFile, fetchImpl, token, gh, owner, repo, prNumber, opts.root);
        abandonSlimRef(execFile, opts.root, opts.branch, true);
        if (err instanceof SlimExit)
            throw err;
        throw new SlimExit(EXIT_FAIL, `pull request failed: ${errText(err)}`);
    }
}
async function createPullRequestRest(opts, ctx) {
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
        const json = (await res.json());
        if (json.number == null || !json.html_url) {
            throw new SlimExit(EXIT_FAIL, "GitHub REST PR create returned no issue number");
        }
        await applyRestLabels(ctx.fetchImpl, ctx.token, ctx.owner, ctx.repo, json.number, opts.labels);
        return { url: json.html_url, number: json.number };
    }
    catch (err) {
        if (err instanceof SlimExit)
            throw err;
        process.stderr.write(`GitHub REST PR create failed: ${errText(err)}\n`);
        throw new SlimExit(EXIT_FAIL, `GitHub REST PR create failed: ${errText(err)}`);
    }
}
export function prBodyFromEvidence(root, pkg) {
    const md = join(root, ".slim", pkg, "evidence.md");
    let text;
    try {
        text = readFileSync(md, "utf8");
    }
    catch {
        throw new SlimExit(EXIT_FAIL, `missing ${md}`);
    }
    assertPrBodyComplete(text);
    return text;
}
//# sourceMappingURL=pr.js.map