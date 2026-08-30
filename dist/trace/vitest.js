import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { siblingModule } from "../runtime-path.js";
import { wrapExports } from "./proxy.js";
import { matchesTracedUrl, packageFromUrl } from "./match.js";
import { extractCjsExportNames, extractEsmExportNames } from "./esm-names.js";
import { errorLine, sessionLine } from "./session.js";
export { wrapExports };
function vitestModuleHref() {
    return pathToFileURL(siblingModule(import.meta.url, "vitest")).href;
}
export function vitestTraceConfigSource(packages, pluginSpecifier, opts) {
    const user = opts?.userConfigSpecifier;
    if (user && opts?.alreadyHasPlugin) {
        return `export { default } from ${JSON.stringify(user)};\n`;
    }
    const pluginConfig = `{
  plugins: [slimVitest({ packages: ${JSON.stringify(packages)} })],
}`;
    if (user) {
        return `import { defineConfig, mergeConfig } from "vitest/config";
import { slimVitest } from ${JSON.stringify(pluginSpecifier)};
import userConfig from ${JSON.stringify(user)};

export default defineConfig(async (env) => {
  const resolved = typeof userConfig === "function" ? await userConfig(env) : userConfig;
  return mergeConfig(resolved, ${pluginConfig});
});
`;
    }
    return `import { slimVitest } from ${JSON.stringify(pluginSpecifier)};

export default ${pluginConfig};
`;
}
function packagesFromEnv() {
    return (process.env.SLIM_TRACE_PACKAGES ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
}
export function slimWrapperSource(id, packageName, names = []) {
    const orig = JSON.stringify(id.includes("?") ? `${id}&slim-orig=1` : `${id}?slim-orig`);
    const spec = JSON.stringify(vitestModuleHref());
    const named = names
        .filter((n) => n !== "default")
        .map((n) => `export const ${n} = wrapped[${JSON.stringify(n)}];`)
        .join("\n");
    const defaultLine = names.includes("default")
        ? "export default wrapped.default !== undefined ? wrapped.default : wrapped;\n"
        : "";
    return `import * as orig from ${orig};
import { wrapExports } from ${spec};
const wrapped = wrapExports(orig, {
  packageName: ${JSON.stringify(packageName)},
  onEvent: (e) => { globalThis.__slimTraceOnEvent && globalThis.__slimTraceOnEvent(e); },
  onError: (e) => { globalThis.__slimTraceOnError && globalThis.__slimTraceOnError(e); },
});
${defaultLine}${named}
`;
}
export function slimVitest(opts) {
    const packages = opts?.packages ?? packagesFromEnv();
    return {
        name: "slim-vitest",
        enforce: "pre",
        config() {
            return {
                optimizeDeps: { exclude: packages },
                ssr: { noExternal: packages },
                test: { server: { deps: { inline: packages } } },
            };
        },
        resolveId(id) {
            if (id.includes("slim-orig"))
                return null;
            return null;
        },
        load(id) {
            if (id.includes("slim-orig"))
                return null;
            if (!matchesTracedUrl(id, packages))
                return null;
            const pkg = packageFromUrl(id, packages) ??
                packages.find((p) => id.includes(`/node_modules/${p}`)) ??
                packages[0] ??
                "unknown";
            return slimWrapperSource(id, pkg, namesFromId(id));
        },
        transform(_code, _id) {
            return null;
        },
    };
}
function namesFromId(id) {
    let file = id.replace(/\?.*$/, "");
    if (file.startsWith("file:")) {
        try {
            file = fileURLToPath(file);
        }
        catch {
            /* keep */
        }
    }
    if (!existsSync(file))
        return [];
    try {
        const src = readFileSync(file, "utf8");
        const parentUrl = pathToFileURL(file).href;
        const names = new Set(extractEsmExportNames(src, {
            parentUrl,
            onUnresolvedStar: (spec) => {
                const outPath = process.env.SLIM_TRACE_OUT;
                if (!outPath)
                    return;
                mkdirSync(dirname(outPath), { recursive: true });
                if (!existsSync(outPath) || readFileSync(outPath, "utf8").length === 0) {
                    writeFileSync(outPath, sessionLine());
                }
                appendFileSync(outPath, errorLine("unresolved-star", spec));
            },
        }));
        for (const n of extractCjsExportNames(src))
            names.add(n);
        if (/\b(?:module\.exports|exports\.)/.test(src))
            names.add("default");
        return [...names];
    }
    catch {
        return [];
    }
}
export default slimVitest;
function ensureVitestSink() {
    const g = globalThis;
    if (typeof g.__slimTraceOnEvent === "function")
        return;
    const outPath = process.env.SLIM_TRACE_OUT;
    if (!outPath)
        return;
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, sessionLine());
    g.__slimTraceOnEvent = (e) => {
        mkdirSync(dirname(outPath), { recursive: true });
        appendFileSync(outPath, JSON.stringify(e) + "\n");
    };
    g.__slimTraceOnError = (e) => {
        mkdirSync(dirname(outPath), { recursive: true });
        appendFileSync(outPath, errorLine(e.kind, e.message));
    };
}
ensureVitestSink();
//# sourceMappingURL=vitest.js.map