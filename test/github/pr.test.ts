import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as pr from "../../src/github/pr.ts";
import { SlimExit, EXIT_ENV, EXIT_FAIL } from "../../src/exit.ts";

const SAMPLE_BODY = `# EVIDENCE, NOT PROOF

## 2. What was used

- Package: \`lodash@4.17.21\` (family \`lodash\`)
- Symbols: \`get\`, \`debounce\`
- Unknowns: 0
- Envelope hash: \`217c102e5c34a74ba017061f1a5574a2ada6cd6a6497e6797e6eb97eafa706c4\`

## 3. Byte delta

71000 B estimated original min → 6981 B replacement

## 5. Fuzz

- cases: 10
- comparisons: 10
- disagreements: 0
- seed: 141647386

## 6. Coverage holes

- debounce options never observed

## 7. Upstream pin

Slim will watch this slice via \`slim upstream\` / osv.dev.

## 8. How to revert

1. Restore \`lodash@4.17.21\` in package.json.

## Residual risk

- Differential fuzzing is evidence, not proof.
`;

const OPTS = {
  root: "/tmp/slim-pr-test-root",
  title: "slim: replace lodash with a verified slice",
  body: SAMPLE_BODY,
  branch: "slim/lodash",
  files: ["src/slim/lodash.ts", ".slim/lodash/evidence.md"],
};

const GH_ARGS = [
  "gh",
  "pr",
  "create",
  "--repo",
  "acme/app",
  "--base",
  "main",
  "--head",
  OPTS.branch,
  "--title",
  OPTS.title,
  "--body",
  OPTS.body,
];

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

function makeExec(opts?: {
  origin?: string;
  commitError?: string;
  base?: string;
  ghUrl?: string;
  pushError?: string;
  ghError?: string;
  remoteError?: string;
  branchExists?: boolean;
  remoteBranch?: boolean;
}) {
  const calls: string[][] = [];
  const execFile: ExecFileFn = (file, args = []) => {
    calls.push([file, ...args]);
    if (file === "git" && args[0] === "show-ref") {
      if (opts?.branchExists) return "";
      throw Object.assign(new Error("not a valid ref"), { status: 1 });
    }
    if (file === "git" && args[0] === "ls-remote") {
      return opts?.remoteBranch ? "abc123\trefs/heads/slim/lodash\n" : "";
    }
    if (file === "git" && args[0] === "rev-parse") {
      if (args.includes("--is-inside-work-tree")) return "true\n";
      return "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n";
    }
    if (file === "git" && args[0] === "write-tree") return "treesha\n";
    if (file === "git" && args[0] === "commit-tree") {
      if (opts?.commitError) {
        throw Object.assign(new Error(opts.commitError), { status: 1 });
      }
      return "commitsha\n";
    }
    if (file === "git" && args[0] === "push" && opts?.pushError) {
      throw Object.assign(new Error(opts.pushError), { status: 1 });
    }
    if (file === "git" && args[0] === "remote") {
      if (opts?.remoteError) {
        throw Object.assign(new Error(opts.remoteError), { status: 1 });
      }
      return `${opts?.origin ?? "git@github.com:acme/app.git"}\n`;
    }
    if (file === "git" && args[0] === "symbolic-ref") {
      return `refs/remotes/origin/${opts?.base ?? "main"}\n`;
    }
    if (file === "gh" && args[0] === "pr") {
      if (opts?.ghError) {
        throw Object.assign(new Error(opts.ghError), { status: 1 });
      }
      return `${opts?.ghUrl ?? "https://github.com/acme/app/pull/7"}\n`;
    }
    return "";
  };
  return { execFile, calls };
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
  const { execFile, calls } = makeExec();
  let fetched = false;
  await assert.rejects(
    () =>
      pr.createPullRequest(OPTS, {
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
  assert.equal(typeof pr.maybeCreatePullRequest, "function");
  let execed = false;
  const result = await pr.maybeCreatePullRequest(false, OPTS, {
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
  const { execFile } = makeExec();
  await assert.rejects(
    () =>
      pr.maybeCreatePullRequest(true, OPTS, {
        hasGh: () => false,
        env: {},
        execFile,
        fetchImpl: async () => new Response("no"),
      }),
    (err: unknown) => err instanceof SlimExit && err.code === EXIT_ENV,
  );
});

test("gh on PATH: prints exact gh pr create invocation then runs equivalent args", async () => {
  const { execFile, calls } = makeExec();
  const { result, stderr } = await withStderr(() =>
    pr.createPullRequest(OPTS, {
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
  assert.deepEqual(ghPr, GH_ARGS);
  assert.ok(stderr.includes(`gh pr create --repo acme/app --base main --head ${OPTS.branch}`), stderr);
  assert.ok(stderr.includes(`--title ${OPTS.title}`), stderr);
  assert.equal(result.local, false);
  assert.equal(result.url, "https://github.com/acme/app/pull/7");
  assertSafeGit(calls);
});

test("GITHUB_TOKEN: REST POST /repos/{owner}/{repo}/pulls after git push", async () => {
  const { execFile, calls } = makeExec({ origin: "https://github.com/acme/app.git" });
  const fetchCalls: { url: string; init?: RequestInit }[] = [];
  let pushed = false;
  const exec: ExecFileFn = (file, args = [], options) => {
    if (file === "git" && args[0] === "push") pushed = true;
    return execFile(file, args, options);
  };
  const result = await pr.createPullRequest(OPTS, {
    hasGh: () => false,
    env: { GITHUB_TOKEN: "ghp_test" },
    execFile: exec,
    fetchImpl: async (url, init) => {
      assert.equal(pushed, true, "git push must run before REST create");
      fetchCalls.push({ url: String(url), init });
      return new Response(JSON.stringify({ html_url: "https://github.com/acme/app/pull/3" }), {
        status: 201,
      });
    },
  });
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0]!.url, "https://api.github.com/repos/acme/app/pulls");
  assert.equal(fetchCalls[0]!.init?.method, "POST");
  assert.equal(header(fetchCalls[0]!.init, "authorization"), "Bearer ghp_test");
  const body = JSON.parse(String(fetchCalls[0]!.init?.body)) as {
    title: string;
    body: string;
    head: string;
    base: string;
  };
  assert.equal(body.title, OPTS.title);
  assert.equal(body.body, OPTS.body);
  assert.equal(body.head, OPTS.branch);
  assert.equal(body.base, "main");
  assert.ok(calls.some((c) => c[0] === "git" && c[1] === "push"));
  assert.equal(calls.some((c) => c[0] === "gh"), false);
  assert.equal(result.local, false);
  assert.equal(result.url, "https://github.com/acme/app/pull/3");
  assertSafeGit(calls);
});

test("gh and REST send equivalent title, body, base, head, and repo", async () => {
  const ghExec = makeExec();
  await withStderr(() =>
    pr.createPullRequest(OPTS, {
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

  const restExec = makeExec({ origin: "git@github.com:acme/app.git" });
  let restPayload: { title: string; body: string; head: string; base: string } | null = null;
  await pr.createPullRequest(OPTS, {
    hasGh: () => false,
    env: { GITHUB_TOKEN: "t" },
    execFile: restExec.execFile,
    fetchImpl: async (url, init) => {
      assert.equal(String(url), "https://api.github.com/repos/acme/app/pulls");
      restPayload = JSON.parse(String(init?.body)) as typeof restPayload;
      return new Response(JSON.stringify({ html_url: "https://github.com/acme/app/pull/1" }), {
        status: 201,
      });
    },
  });
  assert.ok(restPayload);
  assert.equal(repo, "acme/app");
  assert.equal(restPayload.title, title);
  assert.equal(restPayload.body, body);
  assert.equal(restPayload.head, head);
  assert.equal(restPayload.base, base);
  assert.equal(title, OPTS.title);
  assert.equal(body, OPTS.body);
  assert.equal(head, OPTS.branch);
  assert.equal(base, "main");
});

test("GH_TOKEN works when GITHUB_TOKEN is unset; ssh origin parses owner/repo", async () => {
  const { execFile } = makeExec({ origin: "git@github.com:octo/widgets.git", base: "master" });
  const result = await pr.createPullRequest(OPTS, {
    hasGh: () => false,
    env: { GH_TOKEN: "ghp_alt" },
    execFile,
    fetchImpl: async (url, init) => {
      assert.equal(String(url), "https://api.github.com/repos/octo/widgets/pulls");
      assert.equal(header(init, "authorization"), "Bearer ghp_alt");
      const body = JSON.parse(String(init?.body)) as { base: string };
      assert.equal(body.base, "master");
      return new Response(JSON.stringify({ html_url: "https://github.com/octo/widgets/pull/1" }), {
        status: 201,
      });
    },
  });
  assert.equal(result.url, "https://github.com/octo/widgets/pull/1");
});

test("git push failure throws EXIT_FAIL when gh or token exist", async () => {
  const { execFile } = makeExec({ pushError: "Permission denied" });
  await assert.rejects(
    () =>
      withStderr(() =>
        pr.createPullRequest(OPTS, {
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
});

test("gh pr create failure throws EXIT_FAIL", async () => {
  const { execFile } = makeExec({ ghError: "GraphQL: Resource not accessible by integration" });
  await assert.rejects(
    () =>
      withStderr(() =>
        pr.createPullRequest(OPTS, {
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
});

test("REST PR create failure throws EXIT_FAIL", async () => {
  const { execFile } = makeExec({ origin: "https://github.com/acme/app.git" });
  await assert.rejects(
    () =>
      withStderr(() =>
        pr.createPullRequest(OPTS, {
          hasGh: () => false,
          env: { GITHUB_TOKEN: "ghp_test" },
          execFile,
          fetchImpl: async () => new Response("nope", { status: 403 }),
        }),
      ),
    (err: unknown) =>
      err instanceof SlimExit && err.code === EXIT_FAIL && /REST PR create failed/i.test(err.message),
  );
});

test("commit failure is EXIT_FAIL and does not create a PR", async () => {
  const { execFile, calls } = makeExec({
    commitError: "nothing to commit, working tree clean",
  });
  await assert.rejects(
    () =>
      withStderr(() =>
        pr.createPullRequest(OPTS, {
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
  const { execFile } = makeExec({ origin: "git@gitlab.com:acme/app.git" });
  await assert.rejects(
    () =>
      pr.createPullRequest(OPTS, {
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
  const { execFile } = makeExec({ remoteError: "No such remote 'origin'" });
  await assert.rejects(
    () =>
      pr.createPullRequest(OPTS, {
        hasGh: () => true,
        env: {},
        execFile,
        fetchImpl: async () => new Response("no"),
      }),
    (err: unknown) => err instanceof SlimExit && err.code === EXIT_ENV && /origin/i.test(err.message),
  );
});

test("PR body sent to gh and REST includes required evidence fields", async () => {
  const required = [
    /Envelope hash:/i,
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
  ];
  for (const re of required) assert.match(OPTS.body, re);

  const { execFile, calls } = makeExec();
  await withStderr(() =>
    pr.createPullRequest(OPTS, {
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

test("prBodyFromEvidence reads evidence.md and rejects a missing file", () => {
  const root = mkdtempSync(join(tmpdir(), "slim-ev-"));
  mkdirSync(join(root, ".slim", "lodash"), { recursive: true });
  writeFileSync(join(root, ".slim", "lodash", "evidence.md"), SAMPLE_BODY);
  const body = pr.prBodyFromEvidence(root, "lodash");
  assert.match(body, /Envelope hash:/);
  assert.match(body, /Residual risk/);
  assert.throws(
    () => pr.prBodyFromEvidence(root, "missing-pkg"),
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
  const { execFile, calls } = makeExec();
  await assert.rejects(
    () =>
      pr.createPullRequest(
        { ...OPTS, files: [] },
        { hasGh: () => true, env: {}, execFile, fetchImpl: async () => new Response("no") },
      ),
    (err: unknown) =>
      err instanceof SlimExit && err.code === EXIT_FAIL && /no files to commit/i.test(err.message),
  );
  assert.equal(calls.length, 0);
});
