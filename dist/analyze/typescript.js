import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadTargetTypescript, walkSourceFiles, filterSourceFiles } from "../project.js";
import { ENVELOPE_VERSION } from "../envelope/types.js";
import { parseSpecifier, resolvePackageFamily, resolvePackageImports } from "./family.js";
import { refusePackage } from "../scan/refuse.js";
import { readInstalledVersion } from "../size/estimate.js";
import { applySlimmable, usedSliceGraphPure } from "../envelope/slimmable.js";
import { closeEnvelope } from "../envelope/close.js";
import { walkUses } from "./calls.js";
import { collectFileAliases } from "./flow.js";
import { exportNameOf, scriptKind } from "./model.js";
import { createScopedProgram, readTsConfig, shouldEscalate } from "./program.js";
import { collectImports, specifierMatches, wantedSpecifiers, } from "./reexports.js";
import { bindLocalReexports } from "./reexport-bind.js";
import { inferHyrum } from "./shapes.js";
export function analyzePackage(project, pkg, opts = {}) {
    const ts = loadTargetTypescript(project.root);
    const files = filterSourceFiles(walkSourceFiles(project.root), project.root, {
        include: opts.include,
        ignore: opts.ignore,
    });
    const wanted = wantedSpecifiers(pkg);
    const bindings = [];
    const imports = [];
    const callSites = [];
    const unknowns = [];
    const resultMembers = new Map();
    const clockSymbols = new Set(["debounce", "throttle", "delay", "now"]);
    let clock = false;
    let cryptoRandom = pkg === "uuid" || pkg === "nanoid";
    const envKinds = detectEnv(project, files);
    const sourceCache = new Map();
    const getSfLite = (file) => {
        let sf = sourceCache.get(file);
        if (!sf) {
            const text = readFileSync(file, "utf8");
            const kind = scriptKind(ts, file);
            sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
            sourceCache.set(file, sf);
        }
        return sf;
    };
    const walked = files;
    const parsedConfig = readTsConfig(ts, project);
    const programCtx = shouldEscalate(ts, project, walked, getSfLite, parsedConfig)
        ? createScopedProgram(ts, project, walked, parsedConfig)
        : null;
    const getSf = (file) => {
        if (programCtx) {
            const fromProg = programCtx.program.getSourceFile(file);
            if (fromProg)
                return fromProg;
        }
        return getSfLite(file);
    };
    const extra = {
        localPending: [],
        pkgLinks: [],
        localHops: [],
        programCtx,
        root: project.root,
        typeOnly: [],
        unknowns,
        wanted,
    };
    for (const file of walked) {
        const sf = getSf(file);
        collectImports(ts, sf, bindings, imports, wanted, extra);
    }
    for (const file of walked) {
        collectFileAliases(ts, getSf(file), bindings, extra);
    }
    bindLocalReexports(bindings, extra);
    for (const file of walked) {
        const sf = getSf(file);
        walkUses(ts, sf, bindings, wanted, callSites, unknowns, resultMembers, extra, programCtx?.checker);
    }
    const byExport = new Map();
    for (const c of callSites) {
        const list = byExport.get(c.exportName) ?? [];
        list.push(c);
        byExport.set(c.exportName, list);
        if (clockSymbols.has(c.exportName))
            clock = true;
    }
    const family = resolvePackageFamily(pkg);
    const version = readInstalledVersion(project.root, family?.name ?? pkg) ??
        installedFromPkg(project, family?.name ?? pkg);
    const symbols = [...byExport.entries()].map(([exportName, sites]) => ({
        exportName,
        packages: [
            {
                name: family?.name ?? pkg,
                version,
                family: family?.family ?? pkg,
                subpath: family?.subpath ?? "",
            },
        ],
        callSites: sites,
        resultMembers: [...(resultMembers.get(exportName) ?? [])],
        hyrum: inferHyrum(exportName, sites),
        coverage: { callSitesStatic: sites.length, callSitesTraced: 0 },
    }));
    if (symbols.length === 0) {
        for (const b of bindings) {
            if (!specifierMatches(b.specifier, wanted))
                continue;
            if (exportNameOf(b) !== "*")
                continue;
            unknowns.push({
                id: `ns:${b.loc.file}:${b.loc.line}`,
                loc: b.loc,
                kind: "namespace-escape",
                detail: `namespace import of ${b.specifier} with no observed members`,
                widensTo: "all-exports",
                traceObservedMembers: null,
            });
        }
    }
    accountUnobservedImports(imports, callSites, unknowns, wanted);
    const installedName = family?.name ?? pkg;
    const installedDir = join(project.root, "node_modules", installedName);
    const refuse = refusePackage(installedName, existsSync(installedDir) ? installedDir : null);
    const blockers = [];
    if (refuse)
        blockers.push(refuse.why);
    const usedGraphPure = usedSliceGraphPure(project.root, installedName, symbols.map((s) => s.exportName));
    let env = {
        schemaVersion: ENVELOPE_VERSION,
        package: {
            name: family?.name ?? pkg,
            version,
            family: family?.family ?? pkg,
            subpath: family?.subpath ?? "",
        },
        env: envKinds,
        imports: imports.filter((i) => specifierMatches(i.specifier, wanted)),
        symbols,
        unknowns,
        traces: [],
        closure: {
            confidence: "open",
            readyToGenerate: false,
            staticCallSiteIds: [],
            tracedCallSiteIds: [],
            untracedCallSiteIds: [],
            reason: "",
        },
        slimmable: { score: 0, verdict: refuse ? "refuse" : "review", blockers, reasons: [] },
        clock,
        cryptoRandom,
    };
    env = applySlimmable(env, { usedGraphPure });
    env = closeEnvelope(env, { allowUnknown: opts.allowUnknown });
    return env;
}
export function collectPackageSpecifiers(project, opts = {}) {
    const ts = loadTargetTypescript(project.root);
    const files = filterSourceFiles(walkSourceFiles(project.root), project.root, opts);
    const runtime = new Map();
    const typeOnly = new Map();
    for (const file of files) {
        const text = readFileSync(file, "utf8");
        const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(ts, file));
        const dummy = [];
        const imports = [];
        const extra = {
            localPending: [],
            pkgLinks: [],
            localHops: [],
            programCtx: null,
            root: project.root,
            typeOnly: [],
            unknowns: [],
            wanted: null,
        };
        collectImports(ts, sf, dummy, imports, null, extra);
        addSpecifierSites(runtime, imports, project.packageJson.imports);
        addSpecifierSites(typeOnly, extra.typeOnly, project.packageJson.imports);
    }
    return { runtime, typeOnly };
}
export function collectImportSpecifiers(project, opts = {}) {
    return collectPackageSpecifiers(project, opts).runtime;
}
function accountUnobservedImports(imports, callSites, unknowns, wanted) {
    const seen = new Set(unknowns.map((u) => u.id));
    const push = (u) => {
        if (seen.has(u.id))
            return;
        seen.add(u.id);
        unknowns.push(u);
    };
    for (const imp of imports) {
        if (!specifierMatches(imp.specifier, wanted))
            continue;
        if (imp.kind !== "side-effect")
            continue;
        push({
            id: `side:${imp.loc.file}:${imp.loc.line}:${imp.loc.column}`,
            loc: imp.loc,
            kind: "side-effect-import",
            detail: `side-effect import of ${imp.specifier} has no represented init behavior`,
            widensTo: "refuse",
            traceObservedMembers: null,
        });
    }
    if (callSites.length > 0)
        return;
    const observedUnknown = unknowns.some((u) => u.kind !== "unresolved-reexport" &&
        u.kind !== "side-effect-import" &&
        u.kind !== "unobserved-import");
    if (observedUnknown)
        return;
    const hasNsEscape = unknowns.some((u) => u.kind === "namespace-escape");
    for (const imp of imports) {
        if (!specifierMatches(imp.specifier, wanted))
            continue;
        if (imp.kind === "side-effect")
            continue;
        if (imp.kind === "namespace" && hasNsEscape)
            continue;
        push({
            id: `unobs:${imp.loc.file}:${imp.loc.line}:${imp.loc.column}`,
            loc: imp.loc,
            kind: "unobserved-import",
            detail: `import of ${imp.specifier} has no represented runtime use`,
            widensTo: "refuse",
            traceObservedMembers: null,
        });
    }
}
function addSpecifierSites(map, sites, importMap) {
    for (const imp of sites) {
        const resolved = resolvePackageImports(imp.specifier, importMap) ?? imp.specifier;
        const parsed = parseSpecifier(resolved);
        if (!parsed)
            continue;
        const list = map.get(parsed.name) ?? [];
        list.push(imp);
        map.set(parsed.name, list);
    }
}
function detectEnv(project, files) {
    const deps = {
        ...project.packageJson.dependencies,
        ...project.packageJson.devDependencies,
    };
    const tags = [];
    const engines = project.packageJson.engines?.node;
    let hasNodeSpecifier = false;
    for (const f of files) {
        try {
            if (/\bnode:/.test(readFileSync(f, "utf8"))) {
                hasNodeSpecifier = true;
                break;
            }
        }
        catch {
            /* ignore */
        }
    }
    if (deps["@types/node"] || engines || hasNodeSpecifier)
        tags.push("node");
    if (deps["wrangler"] ||
        deps["@cloudflare/workers-types"] ||
        deps["@cloudflare/vitest-pool-workers"] ||
        existsSync(join(project.root, "wrangler.toml"))) {
        tags.push("worker");
    }
    if (deps["jsdom"] || deps["@testing-library/dom"])
        tags.push("jsdom");
    const browserField = project.packageJson.browser;
    const hasDomRuntime = Boolean(deps["react-dom"] || deps["preact"]);
    let hasDomLib = false;
    if (project.tsconfigPath) {
        try {
            const raw = readFileSync(project.tsconfigPath, "utf8");
            if (/"DOM"/i.test(raw) || /'DOM'/i.test(raw))
                hasDomLib = true;
        }
        catch {
            /* ignore */
        }
    }
    if (browserField || hasDomRuntime || (hasDomLib && !tags.includes("node"))) {
        tags.push("browser");
    }
    if (tags.length === 0)
        tags.push("unknown");
    return tags;
}
function installedFromPkg(project, name) {
    const deps = {
        ...project.packageJson.dependencies,
        ...project.packageJson.devDependencies,
        ...project.packageJson.optionalDependencies,
    };
    const raw = deps[name] ?? "";
    return raw.replace(/^[~^>=<\s]+/, "") || "unknown";
}
//# sourceMappingURL=typescript.js.map