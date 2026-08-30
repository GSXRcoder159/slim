import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { siblingModule } from "../runtime-path.js";
import { registerHooks } from "node:module";
import { wrapExports } from "./proxy.js";
import { errorLine, sessionLine } from "./session.js";
import { extractCjsExportNames, extractEsmExportNames } from "./esm-names.js";
import { matchesTracedUrl, packageFromUrl } from "./match.js";
import { Worker as NodeWorker } from "node:worker_threads";
import { createRequire } from "node:module";
export { extractEsmExportNames, matchesTracedUrl, packageFromUrl };
function slimGlobal() {
    return globalThis;
}
function packagesFromEnv() {
    return (process.env.SLIM_TRACE_PACKAGES ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
}
function hasSlimOrig(url) {
    try {
        return new URL(url).searchParams.has("slim-orig");
    }
    catch {
        return url.includes("slim-orig");
    }
}
function addSlimOrig(url) {
    const u = new URL(url);
    u.searchParams.set("slim-orig", "1");
    return u.href;
}
function stripSlimOrig(url) {
    const u = new URL(url);
    u.searchParams.delete("slim-orig");
    return u.href;
}
function sourceToString(source, url) {
    if (typeof source === "string")
        return source;
    if (source instanceof Uint8Array)
        return Buffer.from(source).toString("utf8");
    if (source instanceof ArrayBuffer)
        return Buffer.from(source).toString("utf8");
    try {
        const clean = stripQuery(url);
        if (clean.startsWith("file:"))
            return readFileSync(fileURLToPath(clean), "utf8");
    }
    catch {
        /* ignore */
    }
    return "";
}
function stripQuery(url) {
    try {
        const u = new URL(url);
        u.search = "";
        u.hash = "";
        return u.href;
    }
    catch {
        return url;
    }
}
function siblingHref(name) {
    return pathToFileURL(siblingModule(import.meta.url, name)).href;
}
function reportTraceError(kind, message) {
    const outPath = process.env.SLIM_TRACE_OUT;
    if (!outPath)
        return;
    ensureSessionFile(outPath);
    appendFileSync(outPath, errorLine(kind, message));
}
function hookExecArgv() {
    const extra = [];
    try {
        if (fileURLToPath(import.meta.url).endsWith(".ts"))
            extra.push("--experimental-strip-types");
    }
    catch {
        /* ignore */
    }
    extra.push("--import", import.meta.url);
    return extra;
}
function mergeExecArgv(user, extra) {
    const base = user === undefined ? process.execArgv : [...user];
    const out = [...base];
    for (let i = 0; i < extra.length; i++) {
        const flag = extra[i];
        if (flag === "--import") {
            const href = extra[++i];
            if (!href)
                continue;
            const already = out.some((x, idx) => x === "--import" && out[idx + 1] === href);
            if (!already)
                out.push("--import", href);
            continue;
        }
        if (!out.includes(flag))
            out.push(flag);
    }
    return out;
}
function patchWorkers() {
    const extra = hookExecArgv();
    const importHref = extra[extra.length - 1] ?? "";
    try {
        const req = createRequire(import.meta.url);
        const wt = req("node:worker_threads");
        const Orig = wt.Worker;
        if (Orig.__slimPatched)
            return;
        class SlimWorker extends Orig {
            constructor(filename, options = {}) {
                const execArgv = mergeExecArgv(options.execArgv, extra);
                const env = { ...process.env, ...(options.env ?? {}) };
                if (importHref && !String(env.NODE_OPTIONS ?? "").includes(importHref)) {
                    const nodeOpts = extra.join(" ");
                    env.NODE_OPTIONS = env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ${nodeOpts}` : nodeOpts;
                }
                super(filename, { ...options, execArgv, env });
            }
        }
        SlimWorker.__slimPatched = true;
        Object.defineProperty(wt, "Worker", { value: SlimWorker, configurable: true, writable: true });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reportTraceError("worker", message);
    }
}
function cjsTrailer(packageName) {
    return `

;(() => {
  const g = globalThis;
  if (typeof g.__slimWrapExports === "function") {
    module.exports = g.__slimWrapExports(module.exports, {
      packageName: ${JSON.stringify(packageName)},
      onEvent: (e) => { if (typeof g.__slimTraceOnEvent === "function") g.__slimTraceOnEvent(e); },
      onError: (e) => { if (typeof g.__slimTraceOnError === "function") g.__slimTraceOnError(e); },
    });
  }
})();
`;
}
function esmWrapper(origUrl, names, packageName) {
    const named = names
        .filter((n) => n !== "default")
        .map((n) => `export const ${n} = __slim_wrapped[${JSON.stringify(n)}];`)
        .join("\n");
    const defaultLine = names.includes("default")
        ? "export default __slim_wrapped.default !== undefined ? __slim_wrapped.default : __slim_wrapped;\n"
        : "";
    return `import * as __slim_orig from ${JSON.stringify(origUrl)};
import { wrapExports } from ${JSON.stringify(siblingHref("proxy"))};

const __slim_wrapped = wrapExports(__slim_orig, {
  packageName: ${JSON.stringify(packageName)},
  onEvent: (e) => { globalThis.__slimTraceOnEvent && globalThis.__slimTraceOnEvent(e); },
  onError: (e) => { globalThis.__slimTraceOnError && globalThis.__slimTraceOnError(e); },
});

${defaultLine}${named}
`;
}
function isEsmFormat(format) {
    return format === "module" || format === "module-typescript";
}
let hooksInstalled = false;
const tracedPackages = [];
const eventSinks = [];
const flushers = [];
function dispatchEvent(e) {
    for (const sink of eventSinks)
        sink(e);
}
function loadHook(url, context, nextLoad) {
    if (hasSlimOrig(url))
        return nextLoad(stripSlimOrig(url), context);
    if (!matchesTracedUrl(url, tracedPackages))
        return nextLoad(url, context);
    const pkg = packageFromUrl(url, tracedPackages) ?? tracedPackages[0] ?? "unknown";
    const result = nextLoad(url, context);
    const format = result.format ?? context.format;
    const pathForFormat = stripQuery(url);
    if (format === "json" || format === "builtin" || format === "wasm")
        return result;
    if (/\.json$/i.test(pathForFormat))
        return result;
    if (isEsmFormat(format) || /\.m[jt]s$/i.test(pathForFormat)) {
        const src = sourceToString(result.source, url);
        const names = extractEsmExportNames(src, {
            parentUrl: stripQuery(url),
            onUnresolvedStar: (spec) => reportTraceError("unresolved-star", spec),
        });
        for (const n of extractCjsExportNames(src))
            names.push(n);
        return {
            format: "module",
            shortCircuit: true,
            source: esmWrapper(addSlimOrig(url), [...new Set(names)], pkg),
        };
    }
    // CJS require() often yields format undefined with a source string (Node 22).
    const src = sourceToString(result.source, url);
    return {
        ...result,
        format: "commonjs",
        shortCircuit: true,
        source: src + cjsTrailer(pkg),
    };
}
function installHooks() {
    slimGlobal().__slimWrapExports = wrapExports;
    slimGlobal().__slimTraceOnEvent = dispatchEvent;
    slimGlobal().__slimTraceOnError = (e) => reportTraceError(e.kind, e.message);
    patchWorkers();
    if (hooksInstalled)
        return;
    hooksInstalled = true;
    registerHooks({
        load(url, context, nextLoad) {
            return loadHook(url, context, nextLoad);
        },
    });
    process.on("beforeExit", () => {
        for (const f of flushers) {
            try {
                f();
            }
            catch {
                /* ignore */
            }
        }
    });
}
function ensureSessionFile(outPath) {
    mkdirSync(dirname(outPath), { recursive: true });
    if (!existsSync(outPath) || statSync(outPath).size === 0) {
        writeFileSync(outPath, sessionLine());
        return;
    }
    const head = readFileSync(outPath, "utf8").slice(0, 120);
    if (!head.includes('"t":"session"')) {
        writeFileSync(outPath, sessionLine() + readFileSync(outPath));
    }
}
export function createSlimHooks(opts) {
    const packages = opts.packages;
    const outPath = opts.outPath ?? process.env.SLIM_TRACE_OUT;
    const events = [];
    function onEvent(e) {
        events.push(e);
        if (!outPath)
            return;
        ensureSessionFile(outPath);
        appendFileSync(outPath, JSON.stringify(e) + "\n");
    }
    function flush() {
        if (!outPath)
            return;
        ensureSessionFile(outPath);
    }
    function register() {
        for (const pkg of packages) {
            if (!tracedPackages.includes(pkg))
                tracedPackages.push(pkg);
        }
        if (!eventSinks.includes(onEvent))
            eventSinks.push(onEvent);
        if (!flushers.includes(flush))
            flushers.push(flush);
        if (outPath)
            ensureSessionFile(outPath);
        installHooks();
    }
    return {
        register,
        events: () => events.slice(),
        flush,
    };
}
const envPackages = packagesFromEnv();
if (envPackages.length) {
    createSlimHooks({
        packages: envPackages,
        outPath: process.env.SLIM_TRACE_OUT,
    }).register();
}
//# sourceMappingURL=hook.js.map