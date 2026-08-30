import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
export function findProjectRoot(start = process.cwd()) {
    let dir = resolve(start);
    for (;;) {
        if (existsSync(join(dir, "package.json")))
            return dir;
        const parent = dirname(dir);
        if (parent === dir) {
            throw new Error("No package.json found. Run slim from a Node project.");
        }
        dir = parent;
    }
}
export function detectLockfile(root) {
    if (existsSync(join(root, "pnpm-lock.yaml")))
        return "pnpm";
    if (existsSync(join(root, "yarn.lock")))
        return "yarn";
    if (existsSync(join(root, "bun.lockb")) || existsSync(join(root, "bun.lock")))
        return "bun";
    if (existsSync(join(root, "package-lock.json")))
        return "npm";
    return null;
}
export function loadProject(start = process.cwd()) {
    const root = findProjectRoot(start);
    const packageJsonPath = join(root, "package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    const tsCandidates = ["tsconfig.json", "jsconfig.json"];
    const tsconfigPath = tsCandidates.map((f) => join(root, f)).find((p) => existsSync(p)) ?? null;
    const srcDir = existsSync(join(root, "src")) ? join(root, "src") : root;
    return {
        root,
        packageJsonPath,
        packageJson,
        lockfile: detectLockfile(root),
        tsconfigPath,
        srcDir,
    };
}
export function loadTargetTypescript(projectRoot) {
    const req = createRequire(join(projectRoot, "package.json"));
    try {
        return req("typescript");
    }
    catch {
        let name;
        try {
            name = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"))
                .name;
        }
        catch {
            name = undefined;
        }
        if (name === "slim") {
            try {
                return createRequire(import.meta.url)("typescript");
            }
            catch {
                /* fall through to the same error */
            }
        }
        throw new Error("slim needs typescript to analyze this repo. npm i -D typescript");
    }
}
export function walkSourceFiles(dir, ignore = new Set(["node_modules", "dist", "coverage", ".git", ".slim"])) {
    const out = [];
    if (!existsSync(dir))
        return out;
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
        if (ignore.has(ent.name))
            continue;
        const p = join(dir, ent.name);
        if (ent.isDirectory()) {
            out.push(...walkSourceFiles(p, ignore));
        }
        else if (/\.(c|m)?[jt]sx?$/.test(ent.name) && !ent.name.endsWith(".d.ts")) {
            out.push(p);
        }
    }
    return out;
}
/** Path-substring include/ignore on repo-relative paths. No glob library. */
export function filterSourceFiles(files, root, opts) {
    const include = (opts?.include ?? []).map(normalizePat).filter(Boolean);
    const extraIgnore = (opts?.ignore ?? []).map(normalizePat).filter(Boolean);
    return files.filter((file) => {
        const rel = relative(root, file).replace(/\\/g, "/");
        if (extraIgnore.some((g) => pathMatches(rel, g)))
            return false;
        if (include.length && !include.some((g) => pathMatches(rel, g)))
            return false;
        return true;
    });
}
function normalizePat(pattern) {
    return pattern.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
}
function pathMatches(rel, pattern) {
    return rel === pattern || rel.startsWith(pattern + "/") || rel.includes(pattern);
}
export function fileUrl(abs) {
    return pathToFileURL(resolve(abs)).href;
}
export function isDir(p) {
    try {
        return statSync(p).isDirectory();
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=project.js.map