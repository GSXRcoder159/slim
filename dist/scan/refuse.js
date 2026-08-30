import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
const EXACT = {
    react: {
        why: "framework runtime, not a sliceable utility",
        evidence: "JSX, scheduler, concurrent renderer",
        whatToDo: "Slim does not replace UI frameworks.",
    },
    vue: {
        why: "framework runtime, not a sliceable utility",
        evidence: "compiler + runtime",
        whatToDo: "Slim does not replace UI frameworks.",
    },
    next: {
        why: "application framework",
        evidence: "bundler, router, server",
        whatToDo: "Slim does not replace Next.js.",
    },
    prisma: {
        why: "codegen + engine, not a JS slice",
        evidence: "query engine binary",
        whatToDo: "Keep Prisma. Slim cannot emit a client.",
    },
    typescript: {
        why: "compiler toolchain",
        evidence: "Slim uses the project's typescript to analyze code",
        whatToDo: "Do not replace typescript.",
    },
    eslint: {
        why: "linter toolchain",
        evidence: "plugin ecosystem",
        whatToDo: "Keep eslint.",
    },
    webpack: {
        why: "bundler",
        evidence: "build graph",
        whatToDo: "Keep webpack.",
    },
    vite: {
        why: "bundler / dev server",
        evidence: "plugin graph",
        whatToDo: "Keep vite. Use slim/vitest as a plugin, do not replace Vite.",
    },
    firebase: {
        why: "network SDK surface",
        evidence: "auth/firestore/storage clients",
        whatToDo: "v1 does not rewrite network SDKs.",
    },
    sharp: {
        why: "native addon",
        evidence: "libvips bindings",
        whatToDo: "Native image codecs are not slimmable.",
    },
    canvas: {
        why: "native addon",
        evidence: "Cairo bindings",
        whatToDo: "Native canvas is not slimmable.",
    },
    puppeteer: {
        why: "browser automation + download",
        evidence: "Chrome binary",
        whatToDo: "Not a JS slice.",
    },
    playwright: {
        why: "browser automation + download",
        evidence: "browser binaries",
        whatToDo: "Not a JS slice.",
    },
    axios: {
        why: "network client — envelope is HTTP",
        evidence: "adapters, interceptors",
        whatToDo: "v1 does not rewrite axios to fetch.",
    },
    dotenv: {
        why: "filesystem config loader",
        evidence: "reads .env from disk",
        whatToDo: "v1 does not rewrite fs-bound packages.",
    },
    bindings: {
        why: "native addon loader",
        evidence: "node-gyp / .node",
        whatToDo: "Refuse anything that loads .node binaries.",
    },
    "node-gyp": {
        why: "native addon toolchain",
        evidence: "node-gyp / .node",
        whatToDo: "Refuse anything that loads .node binaries.",
    },
};
const PREFIX = [
    {
        test: (n) => n === "aws-sdk" || n.startsWith("@aws-sdk/"),
        reason: {
            why: "AWS SDK surface is not a utility slice",
            evidence: "service clients + smithy runtime",
            whatToDo: "Keep the SDK. Slim will not emit AWS clients.",
        },
    },
    {
        test: (n) => n === "firebase" || n.startsWith("firebase/") || n.startsWith("@firebase/"),
        reason: {
            why: "network SDK surface",
            evidence: "auth/firestore/storage clients",
            whatToDo: "v1 does not rewrite network SDKs.",
        },
    },
    {
        test: (n) => n === "better-sqlite3" || n.endsWith("/better-sqlite3"),
        reason: {
            why: "native addon",
            evidence: "bindings / node-gyp / .node",
            whatToDo: "Native databases are not slimmable.",
        },
    },
    {
        test: (n) => n === "pdfkit" ||
            n === "pdfjs-dist" ||
            n === "pdf-lib" ||
            n === "jspdf",
        reason: {
            why: "pdf engines are not slimmable yet",
            evidence: "font/cmap/parser tables",
            whatToDo: "Keep the engine. This is a named sequel, not v1.",
        },
    },
    {
        test: (n) => n === "node-fetch" || n === "node-fetch-native" || n === "cross-fetch",
        reason: {
            why: "network client — envelope is HTTP",
            evidence: "fetch polyfill / whatwg-url tree",
            whatToDo: "On Node 22 / Workers, use global fetch. Slim will not rewrite HTTP clients in v1.",
        },
    },
];
export function refusePackage(name, installedDir) {
    const exact = EXACT[name];
    if (exact)
        return { pkg: name, ...exact };
    for (const p of PREFIX) {
        if (p.test(name))
            return { pkg: name, ...p.reason };
    }
    if (installedDir && hasDotNodeFile(installedDir)) {
        return {
            pkg: name,
            why: "native addon",
            evidence: ".node binary in package directory",
            whatToDo: "Refuse anything that loads .node binaries.",
        };
    }
    return null;
}
function hasDotNodeFile(dir) {
    if (!existsSync(dir))
        return false;
    const stack = [dir];
    let n = 0;
    while (stack.length) {
        const d = stack.pop();
        let ents;
        try {
            ents = readdirSync(d, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const e of ents) {
            if (n++ > 2000)
                return false;
            if (e.name === "node_modules")
                continue;
            const p = join(d, e.name);
            if (e.isDirectory())
                stack.push(p);
            else if (e.name.endsWith(".node"))
                return true;
        }
    }
    return false;
}
export function formatRefuse(r) {
    return `refused ${r.pkg}\n  why:      ${r.why}\n  evidence: ${r.evidence}\n  what:     ${r.whatToDo}`;
}
/** Fat / Edge-hostile packages that slim-bloat flags when added without a replacement. */
export const BLOAT_PACKAGES = new Set([
    "lodash",
    "lodash-es",
    "moment",
    "moment-timezone",
    "whatwg-url",
]);
//# sourceMappingURL=refuse.js.map