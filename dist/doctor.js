import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { registerHooks } from "node:module";
import { EXIT_OK, EXIT_ENV } from "./exit.js";
import { JSON_SCHEMA_VERSION, statusFromExit, writeJson } from "./json.js";
import { assertDocument } from "./schema/documents.js";
import { loadProject } from "./project.js";
import { MIN_NODE_LABEL, nodeMeetsMinimum } from "./node-min.js";
export const CJS_HOOKS_LINE = "cjs hooks      recommend Node >= 22.22.3 (documented CJS sync-hook fixes)";
function hasBin(bin) {
    try {
        execFileSync(bin, ["--version"], { stdio: "ignore" });
        return true;
    }
    catch {
        try {
            execFileSync(bin, ["version"], { stdio: "ignore" });
            return true;
        }
        catch {
            return false;
        }
    }
}
export function collectDoctor(cwd = process.cwd(), opts) {
    const issues = [];
    const nodeOk = nodeMeetsMinimum();
    if (!nodeOk) {
        issues.push(`Node ${process.versions.node} is older than ${MIN_NODE_LABEL}. Slim needs registerHooks (${MIN_NODE_LABEL}+) and CJS sync-hook fixes (22.22.3+ recommended).`);
    }
    const hooks = typeof registerHooks === "function";
    if (!hooks)
        issues.push("module.registerHooks is missing on this Node.");
    const gh = hasBin("gh");
    let typescript = false;
    try {
        const project = loadProject(cwd);
        const req = createRequire(project.packageJsonPath);
        req.resolve("typescript");
        typescript = true;
    }
    catch {
        issues.push("typescript is not installed in this project. npm i -D typescript");
    }
    let git = false;
    try {
        execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
            cwd,
            stdio: "ignore",
        });
        git = true;
    }
    catch {
        issues.push("not a git work tree");
    }
    let dirtyTree = false;
    if (git) {
        try {
            const porcelain = opts?.porcelain !== undefined
                ? opts.porcelain
                : execFileSync("git", ["status", "--porcelain"], {
                    cwd,
                    encoding: "utf8",
                });
            dirtyTree = porcelain.trim().length > 0;
        }
        catch {
            dirtyTree = false;
        }
        if (dirtyTree)
            issues.push("working tree is dirty");
    }
    let lockfile = null;
    try {
        lockfile = loadProject(cwd).lockfile;
    }
    catch {
        issues.push("no package.json");
    }
    return {
        node: process.versions.node,
        nodeOk,
        registerHooks: hooks,
        gh,
        typescript,
        git,
        dirtyTree,
        lockfile,
        issues,
    };
}
export function doctorExitCode(report, strict) {
    if (!report.nodeOk || !report.registerHooks)
        return EXIT_ENV;
    if (strict && report.dirtyTree)
        return EXIT_ENV;
    return EXIT_OK;
}
export async function runDoctor(args) {
    const report = collectDoctor();
    const exit = doctorExitCode(report, args.strict);
    if (args.json) {
        const doc = {
            schemaVersion: JSON_SCHEMA_VERSION,
            ok: exit === EXIT_OK,
            exit,
            status: statusFromExit(exit),
            ...report,
        };
        assertDocument("doctor", doc);
        writeJson(doc);
    }
    else {
        process.stdout.write(`node            ${report.node} ${report.nodeOk ? "ok" : "TOO OLD"}\n`);
        process.stdout.write(`registerHooks   ${report.registerHooks ? "yes" : "NO"}\n`);
        process.stdout.write(`gh              ${report.gh ? "yes" : "missing (PR needs gh or GITHUB_TOKEN)"}\n`);
        process.stdout.write(`typescript      ${report.typescript ? "yes" : "NO"}\n`);
        process.stdout.write(`git             ${report.git ? "yes" : "NO"}\n`);
        process.stdout.write(`lockfile        ${report.lockfile ?? "none"}\n`);
        process.stdout.write(`${CJS_HOOKS_LINE}\n`);
        if (report.issues.length) {
            process.stderr.write("\nissues:\n");
            for (const i of report.issues)
                process.stderr.write(`  - ${i}\n`);
        }
        else {
            process.stdout.write("\nready.\n");
        }
    }
    return exit;
}
//# sourceMappingURL=doctor.js.map