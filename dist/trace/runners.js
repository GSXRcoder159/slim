import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { siblingModule } from "../runtime-path.js";
import { vitestTraceConfigSource } from "./vitest.js";
export { vitestTraceConfigSource };
const JEST_SNIPPET = `// Slim v1 does not wrap Jest.
// Jest has no first-class Slim tracing and no shipped setup file.
// Use node:test with --import slim/hooks, or Vitest with the slim/vitest plugin.
// Otherwise run: slim replace <pkg> --no-trace
// Static-only evidence cannot claim runtime/trace closure.`;
export function detectRunner(projectRoot) {
    let pkg;
    try {
        pkg = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
    }
    catch {
        return { kind: "none", command: null };
    }
    const scripts = pkg.scripts ?? {};
    const testScript = scripts.test ?? "";
    const scriptValues = Object.values(scripts);
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const has = (s, re) => re.test(s);
    const anyScript = (re) => scriptValues.some((s) => re.test(s));
    if (has(testScript, /\bvitest\b/) || anyScript(/\bvitest\b/)) {
        const fromOther = scriptValues.find((s) => /\bvitest\b/.test(s));
        return {
            kind: "vitest",
            command: has(testScript, /\bvitest\b/) ? testScript : (fromOther ?? "npx vitest run"),
        };
    }
    if (has(testScript, /\bjest\b/) || anyScript(/\bjest\b/)) {
        return { kind: "jest", command: null, jestSnippet: JEST_SNIPPET };
    }
    if (has(testScript, /--test\b/) ||
        has(testScript, /node:test/) ||
        anyScript(/--test\b/) ||
        anyScript(/node:test/)) {
        const fromOther = scriptValues.find((s) => /--test\b/.test(s) || /node:test/.test(s));
        return {
            kind: "node:test",
            command: has(testScript, /--test\b/) || has(testScript, /node:test/)
                ? testScript
                : (fromOther ?? "node --test"),
        };
    }
    if (deps.vitest)
        return { kind: "vitest", command: "npx vitest run" };
    if (deps.jest)
        return { kind: "jest", command: null, jestSnippet: JEST_SNIPPET };
    return { kind: "none", command: null };
}
export function traceEnv(packages, outPath, root) {
    return {
        ...process.env,
        SLIM_TRACE_PACKAGES: packages.join(","),
        SLIM_TRACE_OUT: outPath,
        ...(root ? { SLIM_TRACE_ROOT: root } : {}),
    };
}
export function nodeTestPreloadArgs(hookModuleAbsPath) {
    const args = ["--import", pathToFileURL(hookModuleAbsPath).href];
    if (hookModuleAbsPath.endsWith(".ts"))
        args.unshift("--experimental-strip-types");
    return args;
}
const VITEST_CONFIG_NAMES = [
    "vitest.config.ts",
    "vitest.config.mts",
    "vitest.config.js",
    "vitest.config.mjs",
    "vitest.config.cts",
    "vitest.config.cjs",
    "vite.config.ts",
    "vite.config.mts",
    "vite.config.js",
    "vite.config.mjs",
];
export function findVitestUserConfig(root) {
    for (const name of VITEST_CONFIG_NAMES) {
        const p = join(root, name);
        if (existsSync(p))
            return p;
    }
    return null;
}
function userConfigHasSlimPlugin(configPath) {
    try {
        const text = readFileSync(configPath, "utf8");
        return /\bslimVitest\b/.test(text) || /["']slim\/vitest["']/.test(text);
    }
    catch {
        return false;
    }
}
function slimVitestSpecifier() {
    const abs = siblingModule(import.meta.url, "vitest");
    if (abs.endsWith(".js"))
        return "slim/vitest";
    return pathToFileURL(abs).href;
}
export function writeVitestTraceConfig(root, packages, configDir = join(root, ".slim")) {
    const dir = configDir;
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "vitest.trace.ts");
    const userAbs = findVitestUserConfig(root);
    let userConfigSpecifier = null;
    let alreadyHasPlugin = false;
    if (userAbs) {
        let rel = relative(dir, userAbs).replace(/\\/g, "/");
        if (!rel.startsWith("."))
            rel = "./" + rel;
        userConfigSpecifier = rel;
        alreadyHasPlugin = userConfigHasSlimPlugin(userAbs);
    }
    writeFileSync(path, vitestTraceConfigSource(packages, slimVitestSpecifier(), {
        userConfigSpecifier,
        alreadyHasPlugin,
    }));
    return path;
}
export function buildTraceSpawn(runner, opts) {
    if (runner.kind === "jest" || runner.kind === "none" || !runner.command)
        return null;
    const parts = runner.command.split(/\s+/).filter(Boolean);
    const file = parts[0];
    if (runner.kind === "node:test") {
        return { file, args: [...nodeTestPreloadArgs(opts.hookPath), ...parts.slice(1)] };
    }
    if (runner.kind === "vitest") {
        const extra = opts.vitestConfigPath ? ["--config", opts.vitestConfigPath] : [];
        return { file, args: [...parts.slice(1), ...extra] };
    }
    return { file, args: parts.slice(1) };
}
//# sourceMappingURL=runners.js.map