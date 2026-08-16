import { test } from "node:test";
import assert from "node:assert/strict";
import * as pr from "../../src/github/pr.ts";
import { SlimExit, EXIT_ENV, EXIT_FAIL } from "../../src/exit.ts";

const OPTS = {
  root: "/tmp/slim-pr-test-root",
  title: "slim: replace lodash with a verified slice",
  body: "EVIDENCE, NOT PROOF",
  branch: "slim/lodash",
};

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

function makeExec(opts?: {
  origin?: string;
  commitError?: string;
  base?: string;
  ghUrl?: string;
  pushError?: string;
  ghError?: string;
  remoteError?: string;
}) {
  const calls: string[][] = [];
  const execFile: ExecFileFn = (file, args = []) => {
    calls.push([file, ...args]);
    if (file === "git" && args[0] === "commit" && opts?.commitError) {
      throw Object.assign(new Error(opts.commitError), { status: 1 });
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

test("createPullRequest throws EXIT_ENV when gh and token are missing", async () => {
  const { execFile } = makeExec();
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
  await assert.rejects(
    () =>
      pr.maybeCreatePullRequest(true, OPTS, {
        hasGh: () => false,
        env: {},
        execFile: () => "",
        fetchImpl: async () => new Response("no"),
      }),
    (err: unknown) => err instanceof SlimExit && err.code === EXIT_ENV,
  );
});

test("gh on PATH: prints exact gh pr create invocation on stderr then runs it", async () => {
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
  const invocation = `gh pr create --title ${OPTS.title} --body ${OPTS.body}`;
  assert.ok(stderr.includes(invocation), `stderr missing invocation:\n${stderr}`);
  const ghPr = calls.find((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "create");
  assert.ok(ghPr, "expected gh pr create");
  assert.deepEqual(ghPr, ["gh", "pr", "create", "--title", OPTS.title, "--body", OPTS.body]);
  assert.equal(result.local, false);
  assert.equal(result.url, "https://github.com/acme/app/pull/7");
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

test("commit failure is written to stderr; still tries PR when branch has commits", async () => {
  const { execFile, calls } = makeExec({
    commitError: "nothing to commit, working tree clean",
  });
  const { result, stderr } = await withStderr(() =>
    pr.createPullRequest(OPTS, {
      hasGh: () => true,
      env: {},
      execFile,
      fetchImpl: async () => {
        throw new Error("should not fetch");
      },
    }),
  );
  assert.match(stderr, /git commit failed/);
  assert.match(stderr, /nothing to commit/);
  assert.ok(calls.some((c) => c[0] === "gh" && c[1] === "pr"));
  assert.equal(result.local, false);
});
