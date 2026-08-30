/**
 * MIT License
 *
 * Attach the extracted npm pack as a child commit and move release tags onto it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EXIT_FAIL, SlimExit } from "../exit.js";
function defaultExec(file, args = [], options) {
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
function gitOut(execFile, args, opts) {
    return String(execFile("git", args, { ...opts, encoding: "utf8" })).trim();
}
function refSha(execFile, gitRoot, ref) {
    try {
        return gitOut(execFile, ["rev-parse", "--verify", "--quiet", ref], {
            cwd: gitRoot,
            stdio: ["ignore", "pipe", "ignore"],
        });
    }
    catch {
        return null;
    }
}
export function attachCompiledTree(opts, execFile = defaultExec) {
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
    const env = {
        ...process.env,
        GIT_INDEX_FILE: indexFile,
        GIT_DIR: gitDir,
        GIT_WORK_TREE: packRoot,
    };
    try {
        execFile("git", ["add", "-A"], { env, encoding: "utf8" });
        const tree = gitOut(execFile, ["write-tree"], { env });
        const message = opts.message ?? `release: attach compiled Action tree for ${opts.versionTag}`;
        const commit = gitOut(execFile, ["commit-tree", tree, "-p", opts.parentSha, "-m", message], { env, cwd: gitRoot });
        execFile("git", ["update-ref", `refs/tags/${opts.versionTag}`, commit], {
            cwd: gitRoot,
            encoding: "utf8",
        });
        execFile("git", ["update-ref", `refs/tags/${opts.floatingTag}`, commit], {
            cwd: gitRoot,
            encoding: "utf8",
        });
        if (opts.push) {
            const remote = opts.remote ?? "origin";
            execFile("git", [
                "push",
                remote,
                `+refs/tags/${opts.versionTag}:refs/tags/${opts.versionTag}`,
                `+refs/tags/${opts.floatingTag}:refs/tags/${opts.floatingTag}`,
            ], { cwd: gitRoot, encoding: "utf8" });
        }
        return {
            commit,
            versionTag: opts.versionTag,
            floatingTag: opts.floatingTag,
            previousVersionSha,
            previousFloatingSha,
        };
    }
    catch (err) {
        if (err instanceof SlimExit)
            throw err;
        throw new SlimExit(EXIT_FAIL, `attach compiled tree failed: ${errText(err)}`);
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
export function rollbackAttach(attached, gitRoot, execFile = defaultExec) {
    restoreTag(execFile, gitRoot, attached.versionTag, attached.previousVersionSha);
    restoreTag(execFile, gitRoot, attached.floatingTag, attached.previousFloatingSha);
}
function restoreTag(execFile, gitRoot, tag, previous) {
    if (previous) {
        execFile("git", ["update-ref", `refs/tags/${tag}`, previous], { cwd: gitRoot, encoding: "utf8" });
        return;
    }
    try {
        execFile("git", ["update-ref", "-d", `refs/tags/${tag}`], { cwd: gitRoot, encoding: "utf8" });
    }
    catch {
        /* already gone */
    }
}
//# sourceMappingURL=attach.js.map