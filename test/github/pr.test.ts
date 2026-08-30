import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as pr from "../../src/github/pr.ts";
import { SlimExit, EXIT_ENV, EXIT_FAIL } from "../../src/exit.ts";
import { plantReplaceTxn, TEST_ARTIFACT_DIGEST } from "../helpers/pr-txn.ts";

type ExecFileFn = (
  file: string,
  args?: readonly string[],
  options?: object,
) => string | Buffer;

function header(init: RequestInit | undefined, name: string): string | null {
  const h = init?.headers;
  if (!h) return null;
  if (h instanceof Headers) return h.get(name);
  if (Array.isArray(h)) {
    const row = h.find(([k]) => k.toLowerCase() === name.toLowerCase());
    return row?.[1] ?? null;
  }
  const rec = h as Record<string, string>;
  const key = Object.keys(rec).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? rec[key]! : null;
}

function assertSafeGit(calls: string[][]): void {
  for (const c of calls) {
    if (c[0] !== "git") continue;
    const joined = c.join(" ");
    assert.equal(c.includes("-B"), false, joined);
    assert.equal(c.includes("--force"), false, joined);
    assert.equal(c[1] === "reset", false, joined);
    assert.equal(c[1] === "checkout", false, joined);
    if (c[1] === "add") assert.equal(c.includes("-A"), false, joined);
  }
}

function ghCreateArgs(opts: pr.CreatePrOpts, repo = "acme/app", base = "main"): string[] {
  return [
    "gh",
    "pr",
    "create",
    "--repo",
    repo,
    "--base",
    base,
    "--head",
    opts.branch,
    "--title",
    opts.title,
    "--body",
    opts.body,
    ...opts.labels.flatMap((l) => ["--label", l]),
  ];
}

const COMMIT_SHA = "c".repeat(40);
const HEAD_SHA = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

function makeExec(opts?: {
  origin?: string;
  commitError?: string;
  base?: string;
  ghUrl?: string;
  pushError?: string;
  ghError?: string;
  viewError?: string;
  viewBody?: string;
  remoteError?: string;
  branchExists?: boolean;
  remoteBranch?: boolean;
  files?: string[];
  message?: string;
  head?: string;
  commit?: string;
  lsRemoteAfterPush?: string;
}) {
  const calls: string[][] = [];
  const files = opts?.files ?? [];
  const message = opts?.message ?? "slim: replace lodash with a verified slice";
  const head = opts?.head ?? HEAD_SHA;
  const commit = opts?.commit ?? COMMIT_SHA;
  const base = opts?.base ?? "main";
  let pushed = false;
  let created: { title: string; body: string; head: string; labels: string[] } | null = null;
  const execFile: ExecFileFn = (file, args = []) => {
    calls.push([file, ...args]);
    if (file === "git" && args[0] === "show-ref") {
      if (opts?.branchExists) return "";
      throw Object.assign(new Error("not a valid ref"), { status: 1 });
    }
    if (file === "git" && args[0] === "ls-remote") {
      if (opts?.remoteBranch && !pushed) return "abc123\trefs/heads/slim/lodash\n";
      if (pushed) {
        if (opts?.lsRemoteAfterPush !== undefined) return opts.lsRemoteAfterPush;
        return `${commit}\trefs/heads/slim/lodash\n`;
      }
      return "";
    }
    if (file === "git" && args[0] === "rev-parse") {
      if (args.includes("--is-inside-work-tree")) return "true\n";
      const last = String(args[args.length - 1] ?? "");
      if (last === "HEAD") return `${head}\n`;
      if (last.endsWith("^")) return `${head}\n`;
      if (last.startsWith("refs/slim-verify/")) return `${commit}\n`;
      if (last === commit) return `${commit}\n`;
      return `${head}\n`;
    }
    if (file === "git" && args[0] === "write-tree") return "treesha\n";
    if (file === "git" && args[0] === "commit-tree") {
      if (opts?.commitError) {
        throw Object.assign(new Error(opts.commitError), { status: 1 });
      }
      return `${commit}\n`;
    }
    if (file === "git" && args[0] === "diff-tree") {
      return files.join("\n") + (files.length ? "\n" : "");
    }
    if (file === "git" && args[0] === "log") {
      return `${message}\n`;
    }
    if (file === "git" && args[0] === "push") {
      if (args.includes("--delete")) return "";
      if (opts?.pushError) {
        throw Object.assign(new Error(opts.pushError), { status: 1 });
      }
      pushed = true;
      return "";
    }
    if (file === "git" && args[0] === "fetch") return "";
    if (file === "git" && args[0] === "update-ref") return "";
    if (file === "git" && args[0] === "remote") {
      if (opts?.remoteError) {
        throw Object.assign(new Error(opts.remoteError), { status: 1 });
      }
      return `${opts?.origin ?? "git@github.com:acme/app.git"}\n`;
    }
    if (file === "git" && args[0] === "symbolic-ref") {
      return `refs/remotes/origin/${base}\n`;
    }
    if (file === "gh" && args[0] === "pr" && args[1] === "create") {
      if (opts?.ghError) {
        throw Object.assign(new Error(opts.ghError), { status: 1 });
      }
      created = {
        title: String(args[args.indexOf("--title") + 1] ?? message),
        body: String(args[args.indexOf("--body") + 1] ?? ""),
        head: String(args[args.indexOf("--head") + 1] ?? "slim/lodash"),
        labels: args.filter((_, i) => args[i - 1] === "--label"),
      };
      return `${opts?.ghUrl ?? "https://github.com/acme/app/pull/7"}\n`;
    }
    if (file === "gh" && args[0] === "pr" && args[1] === "view") {
      if (opts?.viewError) {
        throw Object.assign(new Error(opts.viewError), { status: 1 });
      }
      if (opts?.viewBody) return opts.viewBody;
      const snap = created ?? {
        title: message,
        body: "",
        head: "slim/lodash",
        labels: ["slim", "slim:replace"],
      };
      return JSON.stringify({
        title: snap.title,
        body: snap.body,
        baseRefName: base,
        headRefName: snap.head,
        labels: snap.labels.map((name) => ({ name })),
        files: files.map((path) => ({ path })),
        headRefOid: commit,
        url: opts?.ghUrl ?? "https://github.com/acme/app/pull/7",
      });
    }
    if (file === "gh" && args[0] === "pr" && args[1] === "close") return "";
    return "";
  };
  return { execFile, calls };
}

function restMatching(
  url: string,
  init: RequestInit | undefined,
  opts: pr.CreatePrOpts,
  html = "https://github.com/acme/app/pull/3",
  number = 3,
  sha = COMMIT_SHA,
  overrides?: { title?: string; body?: string; base?: string; head?: string; headSha?: string; status?: number },
): Response {
  const u = String(url);
  const method = (init?.method ?? "GET").toUpperCase();
  if (method === "POST" && u.endsWith("/pulls")) {
    return new Response(JSON.stringify({ html_url: html, number }), { status: 201 });
  }
  if (method === "GET" && /\/pulls\/\d+$/.test(u)) {
    if (overrides?.status) return new Response("no", { status: overrides.status });
    return new Response(
      JSON.stringify({
        html_url: html,
        number,
        title: overrides?.title ?? opts.title,
        body: overrides?.body ?? opts.body,
        base: { ref: overrides?.base ?? "main" },
        head: { ref: overrides?.head ?? opts.branch, sha: overrides?.headSha ?? sha },
      }),
      { status: 200 },
    );
  }
  if (method === "GET" && /\/pulls\/\d+\/files/.test(u)) {
    return new Response(JSON.stringify(opts.files.map((filename) => ({ filename }))), { status: 200 });
  }
  if (method === "GET" && /\/issues\/\d+\/labels/.test(u)) {
    return new Response(JSON.stringify(opts.labels.map((name) => ({ name }))), { status: 200 });
  }
  if (method === "POST" && /\/issues\/\d+\/labels/.test(u)) {
    return new Response("[]", { status: 200 });
  }
  if (method === "POST" && u.endsWith("/labels")) {
    return new Response("{}", { status: 201 });
  }
  if (method === "PATCH" && /\/pulls\/\d+$/.test(u)) {
    return new Response(JSON.stringify({ state: "closed" }), { status: 200 });
  }
  return new Response("no", { status: 500 });
}

async function withStderr<T>(fn: () => Promise<T>): Promise<{ result: T; stderr: string }> {
  const chunks: string[] = [];
  const orig = process.stderr.write;
  process.stderr.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const result = await fn();
    return { result, stderr: chunks.join("") };
  } finally {
    process.stderr.write = orig;
  }
}

test("parseGithubOwnerRepo handles ssh and https origin URLs", () => {
  assert.equal(typeof pr.parseGithubOwnerRepo, "function");
  assert.deepEqual(pr.parseGithubOwnerRepo("git@github.com:acme/app.git"), {
    owner: "acme",
    repo: "app",
  });
  assert.deepEqual(pr.parseGithubOwnerRepo("git@github.com:acme/app"), {
    owner: "acme",
    repo: "app",
  });
  assert.deepEqual(pr.parseGithubOwnerRepo("https://github.com/acme/app.git"), {
    owner: "acme",
    repo: "app",
  });
  assert.deepEqual(pr.parseGithubOwnerRepo("https://github.com/acme/app"), {
    owner: "acme",
    repo: "app",
  });
  assert.deepEqual(pr.parseGithubOwnerRepo("ssh://git@github.com/acme/app.git"), {
    owner: "acme",
    repo: "app",
  });
  assert.deepEqual(
    pr.parseGithubOwnerRepo("https://x-access-token:tok@github.com/acme/app.git"),
    { owner: "acme", repo: "app" },
  );
});

test("parseGithubOwnerRepo rejects non-GitHub remotes", () => {
  assert.throws(
    () => pr.parseGithubOwnerRepo("git@gitlab.com:acme/app.git"),
    (err: unknown) =>
      err instanceof SlimExit && err.code === EXIT_ENV && /cannot parse GitHub owner\/repo/i.test(err.message),
  );
});

test("createPullRequest throws EXIT_ENV when gh and token are missing before git branch", async () => {
  const opts = plantReplaceTxn();
  const { execFile, calls } = makeExec({ files: opts.files, message: opts.title });
  let fetched = false;
  await assert.rejects(
    () =>
      pr.createPullRequest(opts, {
        hasGh: () => false,
        env: {},
        execFile,
        fetchImpl: async () => {
          fetched = true;
          return new Response("no", { status: 500 });
        },
      }),
    (err: unknown) =>
      err instanceof SlimExit &&
      err.code === EXIT_ENV &&
      /install GitHub CLI/i.test(err.message) &&
      /GITHUB_TOKEN/.test(err.message),
  );
  assert.equal(fetched, false);
  assert.equal(calls.some((c) => c[0] === "git" && c[1] === "branch"), false);
  assert.equal(calls.some((c) => c[0] === "git" && c[1] === "commit-tree"), false);
  assert.equal(calls.some((c) => c[0] === "git" && c[1] === "push"), false);
  assertSafeGit(calls);
});

test("maybeCreatePullRequest --no-pr never attempts PR", async () => {
  const opts = plantReplaceTxn();
  assert.equal(typeof pr.maybeCreatePullRequest, "function");
  let execed = false;
  const result = await pr.maybeCreatePullRequest(false, opts, {
    hasGh: () => {
      throw new Error("should not probe gh");
    },
    env: { GITHUB_TOKEN: "secret" },
    execFile: () => {
      execed = true;
      return "";
    },
    fetchImpl: async () => {
      throw new Error("should not fetch");
    },
  });
  assert.equal(result, null);
  assert.equal(execed, false);
});

test("maybeCreatePullRequest requested without gh or token is EXIT_ENV", async () => {
  const opts = plantReplaceTxn();
  const { execFile } = makeExec({ files: opts.files, message: opts.title });
  await assert.rejects(
    () =>
      pr.maybeCreatePullRequest(true, opts, {
        hasGh: () => false,
        env: {},
        execFile,
        fetchImpl: async () => new Response("no"),
      }),
    (err: unknown) => err instanceof SlimExit && err.code === EXIT_ENV,
  );
});

test("gh on PATH: prints exact gh pr create invocation then runs equivalent args", async () => {
  const opts = plantReplaceTxn();
  const { execFile, calls } = makeExec({ files: opts.files, message: opts.title });
  const { result, stderr } = await withStderr(() =>
    pr.createPullRequest(opts, {
      hasGh: () => true,
      env: {},
      execFile,
      fetchImpl: async () => {
        throw new Error("should not fetch when gh is on PATH");
      },
    }),
  );
  const ghPr = calls.find((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "create");
  assert.ok(ghPr, "expected gh pr create");
  assert.deepEqual(ghPr, ghCreateArgs(opts));
  assert.ok(stderr.includes(`gh pr create --repo acme/app --base main --head ${opts.branch}`), stderr);
  assert.ok(stderr.includes(`--title ${opts.title}`), stderr);
  assert.equal(result.local, false);
  assert.equal(result.url, "https://github.com/acme/app/pull/7");
  assert.deepEqual(opts.labels, ["slim", "slim:replace"]);
  assertSafeGit(calls);
});

test("GITHUB_TOKEN: REST POST /repos/{owner}/{repo}/pulls after git push", async () => {
  const opts = plantReplaceTxn();
  const { execFile, calls } = makeExec({ origin: "https://github.com/acme/app.git", files: opts.files, message: opts.title });
  const fetchCalls: { url: string; init?: RequestInit }[] = [];
  let pushed = false;
  const exec: ExecFileFn = (file, args = [], options) => {
    if (file === "git" && args[0] === "push" && !args.includes("--delete")) pushed = true;
    return execFile(file, args, options);
  };
  const result = await pr.createPullRequest(opts, {
    hasGh: () => false,
    env: { GITHUB_TOKEN: "ghp_test" },
    execFile: exec,
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url: String(url), init });
      if ((init?.method ?? "GET").toUpperCase() === "POST" && String(url).endsWith("/pulls")) {
        assert.equal(pushed, true, "git push must run before REST create");
      }
      return restMatching(String(url), init, opts);
    },
  });
  assert.ok(fetchCalls.some((c) => c.url === "https://api.github.com/repos/acme/app/pulls"));
  const pull = fetchCalls.find((c) => c.url.endsWith("/pulls"))!;
  assert.equal(pull.init?.method, "POST");
  assert.equal(header(pull.init, "authorization"), "Bearer ghp_test");
  const body = JSON.parse(String(pull.init?.body)) as {
    title: string;
    body: string;
    head: string;
    base: string;
  };
  assert.equal(body.title, opts.title);
  assert.equal(body.body, opts.body);
  assert.equal(body.head, opts.branch);
  assert.equal(body.base, "main");
  const labelApply = fetchCalls.find((c) => c.url.includes("/issues/3/labels"));
  assert.ok(labelApply, "expected REST label apply");
  assert.deepEqual(JSON.parse(String(labelApply.init?.body)), { labels: ["slim", "slim:replace"] });
  assert.ok(calls.some((c) => c[0] === "git" && c[1] === "push"));
  assert.equal(calls.some((c) => c[0] === "gh"), false);
  assert.equal(result.local, false);
  assert.equal(result.url, "https://github.com/acme/app/pull/3");
  assertSafeGit(calls);
});

test("gh and REST send equivalent title, body, base, head, and repo", async () => {
  const opts = plantReplaceTxn();
  const ghExec = makeExec({ files: opts.files, message: opts.title });
  await withStderr(() =>
    pr.createPullRequest(opts, {
      hasGh: () => true,
      env: {},
      execFile: ghExec.execFile,
      fetchImpl: async () => {
        throw new Error("no fetch");
      },
    }),
  );
  const ghPr = ghExec.calls.find((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "create")!;
  const repo = ghPr[ghPr.indexOf("--repo") + 1];
  const base = ghPr[ghPr.indexOf("--base") + 1];
  const head = ghPr[ghPr.indexOf("--head") + 1];
  const title = ghPr[ghPr.indexOf("--title") + 1];
  const body = ghPr[ghPr.indexOf("--body") + 1];

  const restExec = makeExec({ origin: "git@github.com:acme/app.git", files: opts.files, message: opts.title });
  let restPayload: { title: string; body: string; head: string; base: string } | null = null;
  await pr.createPullRequest(opts, {
    hasGh: () => false,
    env: { GITHUB_TOKEN: "t" },
    execFile: restExec.execFile,
    fetchImpl: async (url, init) => {
      if ((init?.method ?? "GET").toUpperCase() === "POST" && String(url).endsWith("/pulls")) {
        restPayload = JSON.parse(String(init?.body)) as typeof restPayload;
      }
      return restMatching(String(url), init, opts, "https://github.com/acme/app/pull/1", 1);
    },
  });
  assert.ok(restPayload);
  assert.equal(repo, "acme/app");
  assert.equal(restPayload.title, title);
  assert.equal(restPayload.body, body);
  assert.equal(restPayload.head, head);
  assert.equal(restPayload.base, base);
  assert.equal(title, opts.title);
  assert.equal(body, opts.body);
  assert.equal(head, opts.branch);
  assert.equal(base, "main");
});

test("GH_TOKEN works when GITHUB_TOKEN is unset; ssh origin parses owner/repo", async () => {
  const opts = plantReplaceTxn();
  const { execFile } = makeExec({
    origin: "git@github.com:octo/widgets.git",
    base: "master",
    files: opts.files,
    message: opts.title,
  });
  const result = await pr.createPullRequest(opts, {
    hasGh: () => false,
    env: { GH_TOKEN: "ghp_alt" },
    execFile,
    fetchImpl: async (url, init) => {
      if ((init?.method ?? "GET").toUpperCase() === "POST" && String(url).endsWith("/pulls")) {
        assert.equal(String(url), "https://api.github.com/repos/octo/widgets/pulls");
        assert.equal(header(init, "authorization"), "Bearer ghp_alt");
        const body = JSON.parse(String(init?.body)) as { base: string };
        assert.equal(body.base, "master");
      }
      return restMatching(String(url), init, opts, "https://github.com/octo/widgets/pull/1", 1, COMMIT_SHA, {
        base: "master",
      });
    },
  });
  assert.equal(result.url, "https://github.com/octo/widgets/pull/1");
});

test("fork origin is targeted, not an unused upstream parent remote", async () => {
  const opts = plantReplaceTxn();
  const { execFile, calls } = makeExec({
    origin: "git@github.com:fork-user/app.git",
    files: opts.files,
    message: opts.title,
  });
  await withStderr(() =>
    pr.createPullRequest(opts, {
      hasGh: () => true,
      env: {},
      execFile,
      fetchImpl: async () => {
        throw new Error("no fetch");
      },
    }),
  );
  const ghPr = calls.find((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "create")!;
  assert.equal(ghPr[ghPr.indexOf("--repo") + 1], "fork-user/app");
  assert.equal(
    calls.some((c) => c.join(" ").includes("acme/app")),
    false,
  );
});

test("git push failure throws EXIT_FAIL when gh or token exist", async () => {
  const opts = plantReplaceTxn();
  const { execFile, calls } = makeExec({
    pushError: "Permission denied",
    files: opts.files,
    message: opts.title,
  });
  await assert.rejects(
    () =>
      withStderr(() =>
        pr.createPullRequest(opts, {
          hasGh: () => true,
          env: { GITHUB_TOKEN: "ghp_test" },
          execFile,
          fetchImpl: async () => {
            throw new Error("should not fetch after push failure");
          },
        }),
      ),
    (err: unknown) => err instanceof SlimExit && err.code === EXIT_FAIL && /git push failed/i.test(err.message),
  );
  assert.ok(calls.some((c) => c[0] === "git" && c[1] === "branch" && c.includes("-D")));
  assert.equal(calls.some((c) => c[0] === "gh" && c[1] === "pr"), false);
});

test("gh pr create failure throws EXIT_FAIL", async () => {
  const opts = plantReplaceTxn();
  const { execFile, calls } = makeExec({
    ghError: "GraphQL: Resource not accessible by integration",
    files: opts.files,
    message: opts.title,
  });
  await assert.rejects(
    () =>
      withStderr(() =>
        pr.createPullRequest(opts, {
          hasGh: () => true,
          env: {},
          execFile,
          fetchImpl: async () => {
            throw new Error("should not fetch when gh is on PATH");
          },
        }),
      ),
    (err: unknown) =>
      err instanceof SlimExit && err.code === EXIT_FAIL && /gh pr create failed/i.test(err.message),
  );
  assert.ok(calls.some((c) => c[0] === "git" && c[1] === "push" && c.includes("--delete")));
  assert.ok(calls.some((c) => c[0] === "git" && c[1] === "branch" && c.includes("-D")));
});

test("REST PR create failure throws EXIT_FAIL", async () => {
  const opts = plantReplaceTxn();
  const { execFile, calls } = makeExec({
    origin: "https://github.com/acme/app.git",
    files: opts.files,
    message: opts.title,
  });
  await assert.rejects(
    () =>
      withStderr(() =>
        pr.createPullRequest(opts, {
          hasGh: () => false,
          env: { GITHUB_TOKEN: "ghp_test" },
          execFile,
          fetchImpl: async (url, init) => {
            if ((init?.method ?? "GET").toUpperCase() === "POST" && String(url).endsWith("/pulls")) {
              return new Response("nope", { status: 403 });
            }
            return restMatching(String(url), init, opts);
          },
        }),
      ),
    (err: unknown) =>
      err instanceof SlimExit && err.code === EXIT_FAIL && /REST PR create failed/i.test(err.message),
  );
  assert.ok(calls.some((c) => c[0] === "git" && c[1] === "push" && c.includes("--delete")));
});

test("commit failure is EXIT_FAIL and does not create a PR", async () => {
  const opts = plantReplaceTxn();
  const { execFile, calls } = makeExec({
    commitError: "nothing to commit, working tree clean",
    files: opts.files,
    message: opts.title,
  });
  await assert.rejects(
    () =>
      withStderr(() =>
        pr.createPullRequest(opts, {
          hasGh: () => true,
          env: {},
          execFile,
          fetchImpl: async () => {
            throw new Error("should not fetch");
          },
        }),
      ),
    (err: unknown) =>
      err instanceof SlimExit && err.code === EXIT_FAIL && /git commit failed/i.test(err.message),
  );
  assert.equal(calls.some((c) => c[0] === "gh" && c[1] === "pr"), false);
  assert.equal(calls.some((c) => c[0] === "git" && c[1] === "push"), false);
});

test("malformed origin is EXIT_ENV", async () => {
  const opts = plantReplaceTxn();
  const { execFile } = makeExec({ origin: "git@gitlab.com:acme/app.git", files: opts.files, message: opts.title });
  await assert.rejects(
    () =>
      pr.createPullRequest(opts, {
        hasGh: () => true,
        env: {},
        execFile,
        fetchImpl: async () => new Response("no"),
      }),
    (err: unknown) =>
      err instanceof SlimExit && err.code === EXIT_ENV && /cannot parse GitHub owner\/repo/i.test(err.message),
  );
});

test("missing origin remote is EXIT_ENV", async () => {
  const opts = plantReplaceTxn();
  const { execFile } = makeExec({ remoteError: "No such remote 'origin'", files: opts.files, message: opts.title });
  await assert.rejects(
    () =>
      pr.createPullRequest(opts, {
        hasGh: () => true,
        env: {},
        execFile,
        fetchImpl: async () => new Response("no"),
      }),
    (err: unknown) => err instanceof SlimExit && err.code === EXIT_ENV && /origin/i.test(err.message),
  );
});

test("PR body sent to gh includes required evidence fields and matching hashes", async () => {
  const opts = plantReplaceTxn();
  const required = [
    /Envelope hash:/i,
    /Evidence hash:/i,
    /Module digest:/i,
    /Package: /,
    /Symbols:/,
    /Unknowns:/,
    /Coverage holes/i,
    /seed:/i,
    /disagreements:/i,
    /cases:/i,
    /Byte delta/i,
    /Residual risk/i,
    /Upstream pin/i,
    /How to revert/i,
    /Candidate artifact digest:/i,
  ];
  for (const re of required) assert.match(opts.body, re);

  const { execFile, calls } = makeExec({ files: opts.files, message: opts.title });
  await withStderr(() =>
    pr.createPullRequest(opts, {
      hasGh: () => true,
      env: {},
      execFile,
      fetchImpl: async () => {
        throw new Error("no");
      },
    }),
  );
  const ghPr = calls.find((c) => c[0] === "gh" && c[1] === "pr")!;
  const body = ghPr[ghPr.indexOf("--body") + 1]!;
  for (const re of required) assert.match(body, re);
});

test("tampered envelope hash in the PR body blocks commit and push", async () => {
  const opts = plantReplaceTxn();
  opts.body = opts.body.replace(/Envelope hash: `([0-9a-f]+)`/, "Envelope hash: `" + "a".repeat(64) + "`");
  const { execFile, calls } = makeExec({ files: opts.files, message: opts.title });
  await assert.rejects(
    () =>
      pr.createPullRequest(opts, {
        hasGh: () => true,
        env: {},
        execFile,
        fetchImpl: async () => new Response("no"),
      }),
    (err: unknown) =>
      err instanceof SlimExit && err.code === EXIT_FAIL && /envelope hash/i.test(err.message),
  );
  assert.equal(calls.some((c) => c[0] === "git" && c[1] === "commit-tree"), false);
  assert.equal(calls.some((c) => c[0] === "git" && c[1] === "push"), false);
  assert.equal(calls.some((c) => c[0] === "gh"), false);
});

test("wrong package version in the PR body blocks push", async () => {
  const opts = plantReplaceTxn();
  opts.body = opts.body.replace(/lodash@4\.17\.21/, "lodash@9.9.9");
  const { execFile, calls } = makeExec({ files: opts.files, message: opts.title });
  await assert.rejects(
    () =>
      pr.createPullRequest(opts, {
        hasGh: () => true,
        env: {},
        execFile,
        fetchImpl: async () => new Response("no"),
      }),
    (err: unknown) => err instanceof SlimExit && err.code === EXIT_FAIL && /package/i.test(err.message),
  );
  assert.equal(calls.some((c) => c[0] === "git" && c[1] === "commit-tree"), false);
});

test("title that does not name the package blocks push", async () => {
  const opts = plantReplaceTxn();
  opts.title = "totally unrelated title";
  const { execFile, calls } = makeExec({ files: opts.files, message: opts.title });
  await assert.rejects(
    () =>
      pr.createPullRequest(opts, {
        hasGh: () => true,
        env: {},
        execFile,
        fetchImpl: async () => new Response("no"),
      }),
    (err: unknown) => err instanceof SlimExit && err.code === EXIT_FAIL && /title/i.test(err.message),
  );
  assert.equal(calls.some((c) => c[0] === "git" && c[1] === "commit-tree"), false);
});

test("unrelated extra file in the PR file list is refused", async () => {
  const opts = plantReplaceTxn();
  opts.files = [...opts.files, "unrelated.txt"];
  writeFileSync(join(opts.root, "unrelated.txt"), "nope\n");
  const { execFile, calls } = makeExec({ files: opts.files, message: opts.title });
  await assert.rejects(
    () =>
      pr.createPullRequest(opts, {
        hasGh: () => true,
        env: {},
        execFile,
        fetchImpl: async () => new Response("no"),
      }),
    (err: unknown) =>
      err instanceof SlimExit && err.code === EXIT_FAIL && /unrelated path/i.test(err.message),
  );
  assert.equal(calls.some((c) => c[0] === "git" && c[1] === "commit-tree"), false);
});

test("missing evidence.md in the file list is refused", async () => {
  const opts = plantReplaceTxn();
  opts.files = opts.files.filter((f) => !f.endsWith("evidence.md"));
  const { execFile, calls } = makeExec({ files: opts.files, message: opts.title });
  await assert.rejects(
    () =>
      pr.createPullRequest(opts, {
        hasGh: () => true,
        env: {},
        execFile,
        fetchImpl: async () => new Response("no"),
      }),
    (err: unknown) => err instanceof SlimExit && err.code === EXIT_FAIL && /missing .*evidence\.md/i.test(err.message),
  );
  assert.equal(calls.some((c) => c[0] === "git" && c[1] === "commit-tree"), false);
});

test("prBodyFromEvidence reads evidence.md and rejects a missing file", () => {
  const opts = plantReplaceTxn();
  const body = pr.prBodyFromEvidence(opts.root, opts.pkg);
  assert.match(body, /Envelope hash:/);
  assert.match(body, /Evidence hash:/);
  assert.match(body, /Module digest:/);
  assert.match(body, /Residual risk/);
  assert.throws(
    () => pr.prBodyFromEvidence(opts.root, "missing-pkg"),
    (err: unknown) => err instanceof SlimExit && err.code === EXIT_FAIL && /missing/i.test(err.message),
  );
});

test("incomplete evidence.md is EXIT_FAIL", () => {
  const root = mkdtempSync(join(tmpdir(), "slim-ev-"));
  mkdirSync(join(root, ".slim", "lodash"), { recursive: true });
  writeFileSync(join(root, ".slim", "lodash", "evidence.md"), "EVIDENCE, NOT PROOF\n");
  assert.throws(
    () => pr.prBodyFromEvidence(root, "lodash"),
    (err: unknown) => err instanceof SlimExit && err.code === EXIT_FAIL && /required PR fields/i.test(err.message),
  );
});

test("empty files list is EXIT_FAIL before git mutations", async () => {
  const opts = plantReplaceTxn();
  const { execFile, calls } = makeExec({ files: opts.files, message: opts.title });
  await assert.rejects(
    () =>
      pr.createPullRequest(
        { ...opts, files: [] },
        { hasGh: () => true, env: {}, execFile, fetchImpl: async () => new Response("no") },
      ),
    (err: unknown) =>
      err instanceof SlimExit && err.code === EXIT_FAIL && /no files to commit/i.test(err.message),
  );
  assert.equal(calls.length, 0);
});

test("missing candidate artifact digest fails before commit-tree", async () => {
  const opts = plantReplaceTxn();
  delete opts.artifactDigest;
  opts.body = opts.body.replace(/\n\n- Candidate artifact digest: `[0-9a-f]+`\n/, "\n");
  const emptyRoot = mkdtempSync(join(tmpdir(), "slim-no-stamp-"));
  const { execFile, calls } = makeExec({ files: opts.files, message: opts.title });
  await assert.rejects(
    () =>
      pr.createPullRequest(opts, {
        hasGh: () => true,
        env: {},
        execFile,
        packageRoot: emptyRoot,
        fetchImpl: async () => new Response("no"),
      }),
    (err: unknown) =>
      err instanceof SlimExit && err.code === EXIT_FAIL && /missing candidate artifact digest/i.test(err.message),
  );
  assert.equal(calls.some((c) => c[0] === "git" && c[1] === "commit-tree"), false);
  assert.equal(calls.some((c) => c[0] === "git" && c[1] === "push"), false);
});

test("tampered candidate artifact digest in the PR body blocks push", async () => {
  const opts = plantReplaceTxn();
  opts.body = opts.body.replace(TEST_ARTIFACT_DIGEST, "a".repeat(64));
  const { execFile, calls } = makeExec({ files: opts.files, message: opts.title });
  await assert.rejects(
    () =>
      pr.createPullRequest(opts, {
        hasGh: () => true,
        env: {},
        execFile,
        fetchImpl: async () => new Response("no"),
      }),
    (err: unknown) =>
      err instanceof SlimExit && err.code === EXIT_FAIL && /candidate artifact digest/i.test(err.message),
  );
  assert.equal(calls.some((c) => c[0] === "git" && c[1] === "commit-tree"), false);
});

test("wrong base in the request is refused before commit", async () => {
  const opts = plantReplaceTxn();
  opts.base = "develop";
  const { execFile, calls } = makeExec({ files: opts.files, message: opts.title });
  await assert.rejects(
    () =>
      pr.createPullRequest(opts, {
        hasGh: () => true,
        env: {},
        execFile,
        fetchImpl: async () => new Response("no"),
      }),
    (err: unknown) => err instanceof SlimExit && err.code === EXIT_FAIL && /PR base develop/i.test(err.message),
  );
  assert.equal(calls.some((c) => c[0] === "git" && c[1] === "commit-tree"), false);
});

test("remote ls-remote SHA mismatch fails before treating the PR as accepted", async () => {
  const opts = plantReplaceTxn();
  const { execFile, calls } = makeExec({
    files: opts.files,
    message: opts.title,
    lsRemoteAfterPush: `${"a".repeat(40)}\trefs/heads/slim/lodash\n`,
  });
  await assert.rejects(
    () =>
      withStderr(() =>
        pr.createPullRequest(opts, {
          hasGh: () => true,
          env: {},
          execFile,
          fetchImpl: async () => {
            throw new Error("should not fetch after sha mismatch");
          },
        }),
      ),
    (err: unknown) =>
      err instanceof SlimExit && err.code === EXIT_FAIL && /SHA does not match/i.test(err.message),
  );
  assert.equal(calls.some((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "create"), false);
  assert.ok(calls.some((c) => c[0] === "git" && c[1] === "push" && c.includes("--delete")));
});

test("gh pr view title mismatch closes the PR and deletes the Slim branch", async () => {
  const opts = plantReplaceTxn();
  const { execFile, calls } = makeExec({
    files: opts.files,
    message: opts.title,
    viewBody: JSON.stringify({
      title: "wrong title",
      body: opts.body,
      baseRefName: "main",
      headRefName: opts.branch,
      labels: opts.labels.map((name) => ({ name })),
      files: opts.files.map((path) => ({ path })),
      headRefOid: COMMIT_SHA,
      url: "https://github.com/acme/app/pull/7",
    }),
  });
  await assert.rejects(
    () =>
      withStderr(() =>
        pr.createPullRequest(opts, {
          hasGh: () => true,
          env: {},
          execFile,
          fetchImpl: async () => {
            throw new Error("should not REST when gh view mismatches");
          },
        }),
      ),
    (err: unknown) =>
      err instanceof SlimExit && err.code === EXIT_FAIL && /remote PR title/i.test(err.message),
  );
  assert.ok(calls.some((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "close"));
  assert.ok(calls.some((c) => c[0] === "git" && c[1] === "push" && c.includes("--delete")));
  assert.ok(calls.some((c) => c[0] === "git" && c[1] === "branch" && c.includes("-D")));
});

test("REST GET title mismatch closes the PR and deletes the Slim branch", async () => {
  const opts = plantReplaceTxn();
  const { execFile, calls } = makeExec({
    origin: "https://github.com/acme/app.git",
    files: opts.files,
    message: opts.title,
  });
  await assert.rejects(
    () =>
      withStderr(() =>
        pr.createPullRequest(opts, {
          hasGh: () => false,
          env: { GITHUB_TOKEN: "ghp_test" },
          execFile,
          fetchImpl: async (url, init) => restMatching(String(url), init, opts, undefined, undefined, COMMIT_SHA, {
            title: "not the accepted title",
          }),
        }),
      ),
    (err: unknown) =>
      err instanceof SlimExit && err.code === EXIT_FAIL && /remote PR title/i.test(err.message),
  );
  assert.ok(calls.some((c) => c[0] === "git" && c[1] === "push" && c.includes("--delete")));
});

test("REST GET wrong base fails before success", async () => {
  const opts = plantReplaceTxn();
  const { execFile } = makeExec({
    origin: "https://github.com/acme/app.git",
    files: opts.files,
    message: opts.title,
  });
  await assert.rejects(
    () =>
      withStderr(() =>
        pr.createPullRequest(opts, {
          hasGh: () => false,
          env: { GITHUB_TOKEN: "t" },
          execFile,
          fetchImpl: async (url, init) => restMatching(String(url), init, opts, undefined, undefined, COMMIT_SHA, {
            base: "develop",
          }),
        }),
      ),
    (err: unknown) => err instanceof SlimExit && err.code === EXIT_FAIL && /remote PR base/i.test(err.message),
  );
});

test("REST 401 on create is recoverable EXIT_FAIL", async () => {
  const opts = plantReplaceTxn();
  const { execFile, calls } = makeExec({
    origin: "https://github.com/acme/app.git",
    files: opts.files,
    message: opts.title,
  });
  await assert.rejects(
    () =>
      withStderr(() =>
        pr.createPullRequest(opts, {
          hasGh: () => false,
          env: { GITHUB_TOKEN: "ghp_test" },
          execFile,
          fetchImpl: async (url, init) => {
            if ((init?.method ?? "GET").toUpperCase() === "POST" && String(url).endsWith("/pulls")) {
              return new Response("bad creds", { status: 401 });
            }
            return restMatching(String(url), init, opts);
          },
        }),
      ),
    (err: unknown) =>
      err instanceof SlimExit &&
      err.code === EXIT_FAIL &&
      /401/i.test(err.message) &&
      /authentication/i.test(err.message),
  );
  assert.ok(calls.some((c) => c[0] === "git" && c[1] === "push" && c.includes("--delete")));
  assert.equal(calls.some((c) => c[0] === "git" && c.includes("-B")), false);
  assertSafeGit(calls);
});

test("REST 401 on GET after create is recoverable EXIT_FAIL", async () => {
  const opts = plantReplaceTxn();
  const { execFile, calls } = makeExec({
    origin: "https://github.com/acme/app.git",
    files: opts.files,
    message: opts.title,
  });
  await assert.rejects(
    () =>
      withStderr(() =>
        pr.createPullRequest(opts, {
          hasGh: () => false,
          env: { GITHUB_TOKEN: "ghp_test" },
          execFile,
          fetchImpl: async (url, init) =>
            restMatching(String(url), init, opts, undefined, undefined, COMMIT_SHA, { status: 401 }),
        }),
      ),
    (err: unknown) =>
      err instanceof SlimExit && err.code === EXIT_FAIL && /401/i.test(err.message),
  );
  assert.ok(calls.some((c) => c[0] === "git" && c[1] === "push" && c.includes("--delete")));
});

test("success-path stderr and PR body contain no credentials", async () => {
  const opts = plantReplaceTxn();
  const { execFile, calls } = makeExec({ files: opts.files, message: opts.title });
  const { result, stderr } = await withStderr(() =>
    pr.createPullRequest(opts, {
      hasGh: () => true,
      env: {},
      execFile,
      fetchImpl: async () => {
        throw new Error("no fetch");
      },
    }),
  );
  assert.equal(result.url, "https://github.com/acme/app/pull/7");
  const ghPr = calls.find((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "create")!;
  const body = ghPr[ghPr.indexOf("--body") + 1]!;
  assert.match(body, /Candidate artifact digest:/);
  assert.doesNotMatch(body, /ghp_|github_pat|Bearer |token/i);
  assert.doesNotMatch(stderr, /ghp_|github_pat|Bearer /);
  assert.doesNotMatch(stderr, /ANTHROPIC_API_KEY|OPENAI_API_KEY/);
});
