import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as pr from "../../src/github/pr.ts";
import { EXIT_ENV, EXIT_FAIL, SlimExit } from "../../src/exit.ts";
import { plantReplaceTxn } from "../helpers/pr-txn.ts";

const TMP = tmpdir();

type ExecFileFn = (
  file: string,
  args?: readonly string[],
  options?: ExecFileSyncOptions,
) => string | Buffer;

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

function initRepo(): string {
  mkdirSync(TMP, { recursive: true });
  const root = mkdtempSync(join(TMP, "slim-git-"));
  git(root, ["init", "--template=", "-b", "main"]);
  git(root, ["config", "user.email", "slim@test"]);
  git(root, ["config", "user.name", "slim"]);
  writeFileSync(join(root, "README.md"), "hi\n");
  writeFileSync(join(root, "committed.txt"), "orig\n");
  writeFileSync(join(root, "gone.txt"), "delete-me\n");
  git(root, ["add", "README.md", "committed.txt", "gone.txt"]);
  git(root, ["commit", "-m", "init"]);
  return root;
}

function addBareOrigin(root: string): string {
  mkdirSync(TMP, { recursive: true });
  const bare = mkdtempSync(join(TMP, "slim-bare-"));
  execFileSync("git", ["clone", "--bare", "--template=", root, bare], { encoding: "utf8" });
  git(root, ["remote", "add", "origin", bare]);
  git(root, ["fetch", "origin"]);
  git(root, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  return bare;
}

function plantSlimFiles(root: string) {
  return plantReplaceTxn({ root, pkg: "lodash" });
}

function plantDirty(root: string): void {
  writeFileSync(join(root, "committed.txt"), "modified-unrelated\n");
  writeFileSync(join(root, "untracked.txt"), "new-unrelated\n");
  unlinkSync(join(root, "gone.txt"));
  writeFileSync(join(root, "staged.txt"), "staged-unrelated\n");
  git(root, ["add", "staged.txt"]);
  writeFileSync(join(root, ".gitignore"), "secret.bin\n");
  writeFileSync(join(root, "secret.bin"), "ignored\n");
  symlinkSync("committed.txt", join(root, "link-unrelated"));
}

function snapshot(root: string) {
  return {
    branch: git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
    head: git(root, ["rev-parse", "HEAD"]).trim(),
    porcelain: git(root, ["status", "--porcelain=v2"]),
    stage: git(root, ["ls-files", "--stage"]),
    index: readFileSync(join(root, ".git", "index")),
    committed: readFileSync(join(root, "committed.txt")),
    untracked: readFileSync(join(root, "untracked.txt")),
    staged: readFileSync(join(root, "staged.txt")),
    secret: readFileSync(join(root, "secret.bin")),
    gone: existsSync(join(root, "gone.txt")),
    link: readlinkSync(join(root, "link-unrelated")),
  };
}

function assertSafeGit(calls: string[][]): void {
  for (const c of calls) {
    if (c[0] !== "git") continue;
    const joined = c.join(" ");
    assert.equal(c.includes("-B"), false, joined);
    assert.equal(c.includes("--force"), false, joined);
    assert.equal(c[1] === "reset", false, joined);
    assert.equal(c[1] === "checkout", false, joined);
    if (c[1] === "add") {
      assert.equal(c.includes("-A"), false, joined);
    }
  }
}

function execRealGit(extra?: {
  lsRemote?: string;
  pushError?: string;
  commitTreeError?: string;
  ghError?: string;
}): { execFile: ExecFileFn; calls: string[][] } {
  const calls: string[][] = [];
  const execFile: ExecFileFn = (file, args = [], options) => {
    calls.push([file, ...args]);
    if (file === "gh") {
      if (extra?.ghError) {
        throw Object.assign(new Error(extra.ghError), { status: 1 });
      }
      if (args[0] === "pr") return "https://github.com/acme/app/pull/7\n";
      return "gh version 2.0.0\n";
    }
    if (file === "git" && args[0] === "remote" && args.includes("get-url")) {
      return "git@github.com:acme/app.git\n";
    }
    if (file === "git" && args[0] === "ls-remote" && extra?.lsRemote !== undefined) {
      return extra.lsRemote;
    }
    if (file === "git" && args[0] === "push" && extra?.pushError) {
      throw Object.assign(new Error(extra.pushError), { status: 1 });
    }
    if (file === "git" && args[0] === "commit-tree" && extra?.commitTreeError) {
      throw Object.assign(new Error(extra.commitTreeError), { status: 1 });
    }
    return execFileSync(file, [...args], {
      ...options,
      encoding: (options?.encoding as BufferEncoding | undefined) ?? "utf8",
    }) as string | Buffer;
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

test("clean fixture commit contains only intended Slim files", async () => {
  const root = initRepo();
  const bare = addBareOrigin(root);
  const opts = plantSlimFiles(root);
  const { execFile, calls } = execRealGit();
  try {
    const result = await withStderr(() =>
      pr.createPullRequest(
        opts,
        {
          hasGh: () => true,
          env: {},
          execFile,
          fetchImpl: async () => {
            throw new Error("should not fetch");
          },
        },
      ),
    );
    assert.equal(result.result.url, "https://github.com/acme/app/pull/7");
    assert.equal(git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(), "main");
    const diff = git(root, ["diff", "--name-only", "HEAD", opts.branch])
      .trim()
      .split("\n")
      .filter(Boolean)
      .sort();
    assert.deepEqual(diff, [...opts.files].sort());
    assertSafeGit(calls);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  }
});

test("dirty fixture keeps unrelated files and index byte-for-byte", async () => {
  const root = initRepo();
  const bare = addBareOrigin(root);
  plantDirty(root);
  const opts = plantSlimFiles(root);
  const before = snapshot(root);
  const { execFile, calls } = execRealGit();
  try {
    await withStderr(() =>
      pr.createPullRequest(
        opts,
        { hasGh: () => true, env: {}, execFile, fetchImpl: async () => new Response("no") },
      ),
    );
    const after = snapshot(root);
    assert.equal(after.branch, "main");
    assert.equal(after.branch, before.branch);
    assert.equal(after.head, before.head);
    assert.equal(after.porcelain, before.porcelain);
    assert.equal(after.stage, before.stage);
    assert.deepEqual(after.index, before.index);
    assert.deepEqual(after.committed, before.committed);
    assert.deepEqual(after.untracked, before.untracked);
    assert.deepEqual(after.staged, before.staged);
    assert.deepEqual(after.secret, before.secret);
    assert.equal(after.gone, false);
    assert.equal(after.link, before.link);
    assert.equal(after.link, "committed.txt");
    const diff = git(root, ["diff", "--name-only", "HEAD", opts.branch]);
    assert.equal(diff.includes("committed.txt"), false);
    assert.equal(diff.includes("untracked.txt"), false);
    assert.equal(diff.includes("staged.txt"), false);
    assert.equal(diff.includes("secret.bin"), false);
    assert.equal(diff.includes("gone.txt"), false);
    assert.equal(diff.includes("link-unrelated"), false);
    assert.match(diff, /src\/slim\/lodash\.ts/);
    assert.match(diff, /\.slim\/lodash\/evidence\.md/);
    assertSafeGit(calls);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  }
});

test("existing local slim branch is refused without reset", async () => {
  const root = initRepo();
  const bare = addBareOrigin(root);
  const opts = plantSlimFiles(root);
  git(root, ["branch", opts.branch]);
  const before = git(root, ["rev-parse", opts.branch]).trim();
  const { execFile, calls } = execRealGit();
  try {
    await assert.rejects(
      () =>
        withStderr(() =>
          pr.createPullRequest(
            opts,
            { hasGh: () => true, env: {}, execFile, fetchImpl: async () => new Response("no") },
          ),
        ),
      (err: unknown) =>
        err instanceof SlimExit && err.code === EXIT_FAIL && /already exists/i.test(err.message),
    );
    assert.equal(git(root, ["rev-parse", opts.branch]).trim(), before);
    assert.equal(git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(), "main");
    assert.equal(calls.some((c) => c[0] === "git" && c[1] === "push"), false);
    assertSafeGit(calls);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  }
});

test("existing remote slim branch is refused without force push", async () => {
  const root = initRepo();
  const bare = addBareOrigin(root);
  const opts = plantSlimFiles(root);
  git(root, ["branch", opts.branch]);
  git(root, ["push", "origin", opts.branch]);
  git(root, ["branch", "-D", opts.branch]);
  const { execFile, calls } = execRealGit();
  try {
    await assert.rejects(
      () =>
        withStderr(() =>
          pr.createPullRequest(
            opts,
            { hasGh: () => true, env: {}, execFile, fetchImpl: async () => new Response("no") },
          ),
        ),
      (err: unknown) =>
        err instanceof SlimExit &&
        err.code === EXIT_FAIL &&
        /origin already has/i.test(err.message),
    );
    assert.equal(git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(), "main");
    assert.equal(
      existsSync(join(root, ".git", "refs", "heads", "slim", "lodash")),
      false,
    );
    assert.equal(calls.some((c) => c[0] === "git" && c[1] === "push"), false);
    assertSafeGit(calls);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  }
});

test("commit-tree failure is EXIT_FAIL and does not push or create a PR", async () => {
  const root = initRepo();
  const bare = addBareOrigin(root);
  const opts = plantSlimFiles(root);
  const { execFile, calls } = execRealGit({ commitTreeError: "empty ident" });
  try {
    await assert.rejects(
      () =>
        withStderr(() =>
          pr.createPullRequest(
            opts,
            { hasGh: () => true, env: {}, execFile, fetchImpl: async () => new Response("no") },
          ),
        ),
      (err: unknown) =>
        err instanceof SlimExit && err.code === EXIT_FAIL && /git commit failed/i.test(err.message),
    );
    assert.equal(calls.some((c) => c[0] === "git" && c[1] === "push"), false);
    assert.equal(calls.some((c) => c[0] === "gh" && c[1] === "pr"), false);
    assert.equal(git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(), "main");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  }
});

test("missing auth is EXIT_ENV before creating a local branch", async () => {
  const root = initRepo();
  const bare = addBareOrigin(root);
  const opts = plantSlimFiles(root);
  const { execFile, calls } = execRealGit();
  try {
    await assert.rejects(
      () =>
        pr.createPullRequest(
          opts,
          {
            hasGh: () => false,
            env: {},
            execFile,
            fetchImpl: async () => {
              throw new Error("should not fetch");
            },
          },
        ),
      (err: unknown) => err instanceof SlimExit && err.code === EXIT_ENV && /GITHUB_TOKEN/.test(err.message),
    );
    assert.equal(calls.some((c) => c[0] === "git" && c[1] === "branch"), false);
    assert.equal(calls.some((c) => c[0] === "git" && c[1] === "commit-tree"), false);
    assert.equal(calls.some((c) => c[0] === "git" && c[1] === "push"), false);
    assert.equal(
      existsSync(join(root, ".git", "refs", "heads", "slim", "lodash")),
      false,
    );
    assertSafeGit(calls);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  }
});

test("detached HEAD stays detached and still creates the named branch", async () => {
  const root = initRepo();
  const bare = addBareOrigin(root);
  const opts = plantSlimFiles(root);
  git(root, ["checkout", "--detach"]);
  const { execFile, calls } = execRealGit();
  try {
    await withStderr(() =>
      pr.createPullRequest(
        opts,
        { hasGh: () => true, env: {}, execFile, fetchImpl: async () => new Response("no") },
      ),
    );
    assert.equal(git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(), "HEAD");
    git(root, ["rev-parse", "--verify", opts.branch]);
    assertSafeGit(calls);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  }
});

test("push failure deletes the local Slim branch and leaves HEAD intact", async () => {
  const root = initRepo();
  const bare = addBareOrigin(root);
  const opts = plantSlimFiles(root);
  const head = git(root, ["rev-parse", "HEAD"]).trim();
  const { execFile, calls } = execRealGit({ pushError: "Permission denied" });
  try {
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
      (err: unknown) => err instanceof SlimExit && err.code === EXIT_FAIL && /git push failed/i.test(err.message),
    );
    assert.equal(git(root, ["rev-parse", "HEAD"]).trim(), head);
    assert.equal(git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(), "main");
    assert.equal(existsSync(join(root, ".git", "refs", "heads", "slim", "lodash")), false);
    assert.equal(calls.some((c) => c[0] === "gh" && c[1] === "pr"), false);
    assertSafeGit(calls);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  }
});

test("gh failure deletes the pushed Slim branch locally and remotely", async () => {
  const root = initRepo();
  const bare = addBareOrigin(root);
  const opts = plantSlimFiles(root);
  const { execFile, calls } = execRealGit({ ghError: "GraphQL: Resource not accessible" });
  try {
    await assert.rejects(
      () =>
        withStderr(() =>
          pr.createPullRequest(opts, {
            hasGh: () => true,
            env: {},
            execFile,
            fetchImpl: async () => new Response("no"),
          }),
        ),
      (err: unknown) =>
        err instanceof SlimExit && err.code === EXIT_FAIL && /gh pr create failed/i.test(err.message),
    );
    assert.equal(git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(), "main");
    assert.equal(existsSync(join(root, ".git", "refs", "heads", "slim", "lodash")), false);
    let remoteHeads = "";
    try {
      remoteHeads = execFileSync("git", ["--git-dir", bare, "show-ref", "--heads", opts.branch], {
        encoding: "utf8",
      }).trim();
    } catch {
      remoteHeads = "";
    }
    assert.equal(remoteHeads, "");
    assertSafeGit(calls);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  }
});
