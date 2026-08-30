/**
 * MIT License
 *
 * Attach the extracted npm pack as a child commit and move release tags onto it.
 */

import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EXIT_FAIL, SlimExit } from "../exit.ts";

export type ExecFileFn = (
  file: string,
  args?: readonly string[],
  options?: ExecFileSyncOptions,
) => string | Buffer;

function defaultExec(
  file: string,
  args: readonly string[] = [],
  options?: ExecFileSyncOptions,
): string | Buffer {
  return execFileSync(file, [...args], options);
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

function gitOut(execFile: ExecFileFn, args: string[], opts: ExecFileSyncOptions): string {
  return String(execFile("git", args, { ...opts, encoding: "utf8" })).trim();
}

function refSha(execFile: ExecFileFn, gitRoot: string, ref: string): string | null {
  try {
    return gitOut(execFile, ["rev-parse", "--verify", "--quiet", ref], {
      cwd: gitRoot,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

export interface AttachResult {
  commit: string;
  versionTag: string;
  floatingTag: string;
  previousVersionSha: string | null;
  previousFloatingSha: string | null;
}

export interface AttachOpts {
  gitRoot: string;
  packRoot: string;
  parentSha: string;
  versionTag: string;
  floatingTag: string;
  push?: boolean;
  remote?: string;
  message?: string;
}

export function attachCompiledTree(opts: AttachOpts, execFile: ExecFileFn = defaultExec): AttachResult {
  const gitRoot = resolve(opts.gitRoot);
  const packRoot = resolve(opts.packRoot);
  const gitDir = join(gitRoot, ".git");
  if (!existsSync(gitDir)) {
    throw new SlimExit(EXIT_FAIL, `not a git repository: ${gitRoot}`);
  }
  if (!existsSync(packRoot)) {
    throw new SlimExit(EXIT_FAIL, `missing pack root ${packRoot}`);
  }

  const previousVersionSha = refSha(execFile, gitRoot, `refs/tags/${opts.versionTag}`);
  const previousFloatingSha = refSha(execFile, gitRoot, `refs/tags/${opts.floatingTag}`);

  const indexFile = join(tmpdir(), `slim-release-index-${process.pid}-${Date.now()}`);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_INDEX_FILE: indexFile,
    GIT_DIR: gitDir,
    GIT_WORK_TREE: packRoot,
  };
  try {
    execFile("git", ["add", "-A"], { env, encoding: "utf8" });
    const tree = gitOut(execFile, ["write-tree"], { env });
    const message =
      opts.message ?? `release: attach compiled Action tree for ${opts.versionTag}`;
    const commit = gitOut(
      execFile,
      ["commit-tree", tree, "-p", opts.parentSha, "-m", message],
      { env, cwd: gitRoot },
    );
    execFile("git", ["update-ref", `refs/tags/${opts.versionTag}`, commit], {
      cwd: gitRoot,
      encoding: "utf8",
    });
    execFile("git", ["update-ref", `refs/tags/${opts.floatingTag}`, commit], {
      cwd: gitRoot,
      encoding: "utf8",
    });
    if (opts.push) {
      pushReleaseTags(
        {
          commit,
          versionTag: opts.versionTag,
          floatingTag: opts.floatingTag,
          previousVersionSha,
          previousFloatingSha,
        },
        gitRoot,
        opts.remote ?? "origin",
        execFile,
      );
    }
    return {
      commit,
      versionTag: opts.versionTag,
      floatingTag: opts.floatingTag,
      previousVersionSha,
      previousFloatingSha,
    };
  } catch (err) {
    if (err instanceof SlimExit) throw err;
    throw new SlimExit(EXIT_FAIL, `attach compiled tree failed: ${errText(err)}`);
  } finally {
    try {
      if (existsSync(indexFile)) unlinkSync(indexFile);
    } catch {
      /* leftover index is tmp */
    }
  }
}

export function pushReleaseTags(
  attached: AttachResult,
  gitRoot: string,
  remote = "origin",
  execFile: ExecFileFn = defaultExec,
): void {
  execFile(
    "git",
    [
      "push",
      remote,
      `+refs/tags/${attached.versionTag}:refs/tags/${attached.versionTag}`,
      `+refs/tags/${attached.floatingTag}:refs/tags/${attached.floatingTag}`,
    ],
    { cwd: gitRoot, encoding: "utf8" },
  );
}

export function rollbackAttach(
  attached: AttachResult,
  gitRoot: string,
  execFile: ExecFileFn = defaultExec,
  opts?: { push?: boolean; remote?: string },
): void {
  restoreTag(execFile, gitRoot, attached.versionTag, attached.previousVersionSha);
  restoreTag(execFile, gitRoot, attached.floatingTag, attached.previousFloatingSha);
  if (opts?.push) {
    const remote = opts.remote ?? "origin";
    pushRestoredTag(execFile, gitRoot, remote, attached.versionTag, attached.previousVersionSha);
    pushRestoredTag(execFile, gitRoot, remote, attached.floatingTag, attached.previousFloatingSha);
  }
}

function pushRestoredTag(
  execFile: ExecFileFn,
  gitRoot: string,
  remote: string,
  tag: string,
  previous: string | null,
): void {
  const spec = previous ? `+${previous}:refs/tags/${tag}` : `:refs/tags/${tag}`;
  try {
    execFile("git", ["push", remote, spec], { cwd: gitRoot, encoding: "utf8" });
  } catch {
    /* remote tag may already match */
  }
}

function restoreTag(
  execFile: ExecFileFn,
  gitRoot: string,
  tag: string,
  previous: string | null,
): void {
  if (previous) {
    execFile("git", ["update-ref", `refs/tags/${tag}`, previous], { cwd: gitRoot, encoding: "utf8" });
    return;
  }
  try {
    execFile("git", ["update-ref", "-d", `refs/tags/${tag}`], { cwd: gitRoot, encoding: "utf8" });
  } catch {
    /* already gone */
  }
}
