import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { EXIT_FAIL } from "../src/exit.ts";
import { hermeticPmEnv, execPm } from "../src/rewrite/lockfile.ts";
import { plantReplaceTxn } from "./helpers/pr-txn.ts";
import { packSlim } from "./helpers/llm-replace.ts";
import { packageNodeModulesDir } from "../src/release/identity.ts";

type CreatePrOpts = {
  root: string;
  title: string;
  body: string;
  branch: string;
  files: string[];
  labels: string[];
  kind?: string;
  pkg?: string;
  artifactDigest?: string;
  base?: string;
};

type ExecFileFn = (
  file: string,
  args?: readonly string[],
  options?: ExecFileSyncOptions,
) => string | Buffer;

type PackedPr = {
  createPullRequest: (
    opts: CreatePrOpts,
    deps?: {
      hasGh?: () => boolean;
      env?: NodeJS.ProcessEnv;
      execFile?: ExecFileFn;
      fetchImpl?: typeof fetch;
    },
  ) => Promise<{ url: string | null; local: boolean }>;
};

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

function initRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "slim-packed-pr-"));
  git(root, ["init", "--template=", "-b", "main"]);
  git(root, ["config", "user.email", "slim@test"]);
  git(root, ["config", "user.name", "slim"]);
  writeFileSync(join(root, "README.md"), "hi\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-m", "init"]);
  return root;
}

function addBareOrigin(root: string): string {
  const bare = mkdtempSync(join(tmpdir(), "slim-packed-pr-bare-"));
  execFileSync("git", ["clone", "--bare", "--template=", root, bare], { encoding: "utf8" });
  git(root, ["remote", "add", "origin", bare]);
  git(root, ["fetch", "origin"]);
  git(root, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  return bare;
}

function mockGh(viewMismatch = false): {
  execFile: ExecFileFn;
  calls: string[][];
} {
  const calls: string[][] = [];
  let created: { title: string; body: string; head: string; base: string; labels: string[] } | null = null;
  const execFile: ExecFileFn = (file, args = [], options) => {
    calls.push([file, ...args]);
    if (file === "gh") {
      if (args[0] === "pr" && args[1] === "create") {
        created = {
          title: String(args[args.indexOf("--title") + 1] ?? ""),
          body: String(args[args.indexOf("--body") + 1] ?? ""),
          head: String(args[args.indexOf("--head") + 1] ?? ""),
          base: String(args[args.indexOf("--base") + 1] ?? "main"),
          labels: args.filter((_, i) => args[i - 1] === "--label"),
        };
        return "https://github.com/acme/app/pull/7\n";
      }
      if (args[0] === "pr" && args[1] === "view") {
        const cwd =
          typeof options === "object" && options && "cwd" in options
            ? String((options as { cwd?: string }).cwd ?? "")
            : "";
        const branch = created?.head || "slim/lodash";
        const sha = cwd
          ? execFileSync("git", ["rev-parse", branch], { cwd, encoding: "utf8" }).trim()
          : "c".repeat(40);
        const fileList = cwd
          ? execFileSync("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", sha], {
              cwd,
              encoding: "utf8",
            })
              .trim()
              .split("\n")
              .filter(Boolean)
          : [];
        return `${JSON.stringify({
          title: viewMismatch ? "not the accepted title" : created?.title,
          body: created?.body ?? "",
          baseRefName: created?.base ?? "main",
          headRefName: branch,
          labels: (created?.labels ?? []).map((name) => ({ name })),
          files: fileList.map((path) => ({ path })),
          headRefOid: sha,
          url: "https://github.com/acme/app/pull/7",
        })}\n`;
      }
      if (args[0] === "pr" && args[1] === "close") return "";
      return "gh version 2.0.0\n";
    }
    if (file === "git" && args[0] === "remote" && args.includes("get-url")) {
      return "git@github.com:acme/app.git\n";
    }
    return execFileSync(file, [...args], {
      ...options,
      encoding: (options?.encoding as BufferEncoding | undefined) ?? "utf8",
    }) as string | Buffer;
  };
  return { execFile, calls };
}

let packDir = "";
let host = "";
let createPullRequest: PackedPr["createPullRequest"];

before(async () => {
  const packed = packSlim();
  packDir = packed.packDir;
  host = mkdtempSync(join(tmpdir(), "slim-pr-pack-host-"));
  writeFileSync(join(host, "package.json"), JSON.stringify({ name: "host", private: true }));
  execPm("npm", ["install", packed.tarball, "--omit=dev"], {
    cwd: host,
    encoding: "utf8",
    timeout: 300_000,
    env: hermeticPmEnv(),
  });
  const mod = (await import(
    pathToFileURL(join(packageNodeModulesDir(host), "dist", "github", "pr.js")).href
  )) as PackedPr;
  createPullRequest = mod.createPullRequest;
}, { timeout: 400_000 });

after(() => {
  if (host) rmSync(host, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  if (packDir) rmSync(packDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

test("packed createPullRequest succeeds when the independent remote PR matches", { timeout: 180_000 }, async () => {
  const root = initRepo();
  const bare = addBareOrigin(root);
  const opts = plantReplaceTxn({ root });
  const { execFile } = mockGh();
  try {
    const result = await createPullRequest(opts, {
      hasGh: () => true,
      env: {},
      execFile,
      fetchImpl: async () => {
        throw new Error("packed success path uses gh pr view");
      },
    });
    assert.equal(result.url, "https://github.com/acme/app/pull/7");
    assert.equal(git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(), "main");
    assert.match(opts.body, /Candidate artifact digest:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  }
});

test("packed createPullRequest fails closed when the remote PR title mismatches", { timeout: 180_000 }, async () => {
  const root = initRepo();
  const bare = addBareOrigin(root);
  const opts = plantReplaceTxn({ root });
  const { execFile, calls } = mockGh(true);
  try {
    await assert.rejects(
      () =>
        createPullRequest(opts, {
          hasGh: () => true,
          env: {},
          execFile,
          fetchImpl: async () => new Response("no"),
        }),
      (err: unknown) => {
        const e = err as { code?: number; message?: string };
        return e.code === EXIT_FAIL && /remote PR title/i.test(e.message ?? "");
      },
    );
    assert.equal(git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(), "main");
    assert.ok(calls.some((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "close"));
    assert.ok(calls.some((c) => c[0] === "git" && c[1] === "push" && c.includes("--delete")));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  }
});
