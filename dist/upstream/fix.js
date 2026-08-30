var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnPm } from "../rewrite/lockfile.js";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { hashEnvelope, envelopeForDisk } from "../envelope/types.js";
import { EXIT_FAIL, SlimExit } from "../exit.js";
import { assembleCatalogModule } from "../generate/assemble.js";
import { matchCatalog } from "../generate/catalog/index.js";
import { slimRoot } from "../generate/guard.js";
import { llmConfigFromEnv, generateWithLlm } from "../generate/llm.js";
import { loadPublicApi } from "../generate/public-api.js";
import { assertValidGenerated, assertSmaller } from "../generate/validate.js";
import { checkContracts } from "../generate/exports.js";
import { writeEvidence } from "../evidence/report.js";
import { emitHardenedGetSetTest, emitStandingTests } from "../evidence/emit-tests.js";
import { runFuzz } from "../fuzz/run.js";
import { loadTargetTypescript } from "../project.js";
import { runHardenedTests, runStandingTests } from "../check.js";
import { standingTestPaths } from "../evidence/paths.js";
import { MutationTxn } from "../rewrite/transaction.js";
import { detectRunner } from "../trace/runners.js";
import { estimatePackageSize } from "../size/estimate.js";
import { assertDocument, readDocument } from "../schema/documents.js";
import { resolveReplacementPaths } from "./state.js";
export async function canFuzzOracle(opts, deps = {}) {
    const env = loadEnvelope(opts);
    const symbols = usedSymbols(env, opts.rec);
    const latest = opts.findings[0]?.latest ?? opts.rec.version;
    const oracle = await resolveOracle(opts, deps, latest, symbols);
    if (oracle?.tempDir) {
        try {
            rmSync(oracle.tempDir, { recursive: true, force: true });
        }
        catch {
            /* tmp */
        }
    }
    return oracle !== null;
}
export async function applyUpstreamFix(opts, deps = {}, sharedTxn) {
    const paths = resolveReplacementPaths(opts.root, opts.pkg, opts.rec, stateOpts(opts));
    const env = loadEnvelope(opts);
    const symbols = usedSymbols(env, opts.rec);
    const catalog = (deps.matchCatalog ?? matchCatalog)(opts.pkg, symbols);
    const llmCfg = (deps.llmConfigFromEnv ?? llmConfigFromEnv)();
    const assemble = deps.assembleCatalogModule ?? assembleCatalogModule;
    const genLlm = deps.generateWithLlm ?? generateWithLlm;
    const fuzzImpl = deps.runFuzz ?? runFuzz;
    const standing = deps.runStandingTests ?? runStandingTests;
    const hardened = deps.runHardenedTests ?? runHardenedTests;
    const ts = loadTs(opts.root);
    let source = null;
    let usedCatalog = false;
    let pub = undefined;
    let gen = undefined;
    if (catalog.missing.length === 0 && catalog.matched.length) {
        source = assemble(env, opts.root);
        if (!source) {
            throw new SlimExit(EXIT_FAIL, `catalog matched but assemble failed for ${opts.pkg}`);
        }
        usedCatalog = true;
        assertValidGenerated(ts, source, env);
        const contracts = checkContracts(ts, source, env);
        if (!contracts.ok) {
            throw new SlimExit(EXIT_FAIL, `missing named export: ${contracts.errors.join("; ")}`);
        }
    }
    else if (llmCfg) {
        pub = loadPublicApi(opts.root, opts.pkg, env.package.subpath);
        gen = await genLlm(env, pub, advisoryAbstracts(opts.findings), llmCfg);
        source = gen.source;
        assertValidGenerated(ts, source, env);
        const contracts = checkContracts(ts, source, env);
        if (!contracts.ok) {
            throw new SlimExit(EXIT_FAIL, `missing named export: ${contracts.errors.join("; ")}`);
        }
    }
    if (!source) {
        throw new SlimExit(EXIT_FAIL, `could not regenerate ${opts.pkg}: no catalog match and no LLM key`);
    }
    let oracleTemp;
    let srcTemp;
    const txn = sharedTxn ?? new MutationTxn(opts.root);
    const ownsTxn = !sharedTxn;
    try {
        srcTemp = mkdtempSync(join(tmpdir(), "slim-up-src-"));
        const tmpSlim = join(srcTemp, "slim.mjs");
        writeFileSync(tmpSlim, ts.transpileModule(source, {
            compilerOptions: {
                module: ts.ModuleKind.ESNext,
                target: ts.ScriptTarget.ES2022,
                moduleResolution: ts.ModuleResolutionKind.NodeNext,
            },
            fileName: join(opts.root, opts.rec.module),
        }).outputText);
        const replacement = await loadReplacementFns(tmpSlim);
        const latest = opts.findings[0]?.latest ?? opts.rec.version;
        const oracle = await resolveOracle(opts, deps, latest, symbols);
        oracleTemp = oracle?.tempDir;
        if (!oracle) {
            throw new SlimExit(EXIT_FAIL, "verification unavailable: no installable oracle");
        }
        const originalMin = estimatePackageSize(oracle.tempDir ?? opts.root, opts.pkg).minBytes;
        assertSmaller(Buffer.byteLength(source), originalMin ?? 0, false);
        const budgetMs = opts.args.budgetMs ?? Math.min(opts.config.budgetMs, 5_000);
        const report = await fuzzImpl({
            original: oracle.fns,
            replacement: replacement ?? {},
            envelope: env,
            budgetMs,
            seed: 1,
            workers: 1,
        });
        const dropProto = usedCatalog && oracle.kind === "old";
        const disagreements = dropProto
            ? report.disagreements.filter((d) => !isProtoPollutionCase(d))
            : report.disagreements;
        if (disagreements.length) {
            const first = disagreements[0];
            const msg = usedCatalog
                ? `catalog disagreement (Slim bug, not LLM-patched): ${first.symbol} ${first.reason}`
                : `fuzz disagreements remain: ${first.symbol} ${first.reason}`;
            throw new SlimExit(EXIT_FAIL, msg);
        }
        if (replacement && (typeof replacement.get === "function" || typeof replacement.set === "function")) {
            assertHardenedGetSet(replacement);
        }
        const pinTo = oracle.kind === "new" ? latest : opts.rec.version;
        const envWrite = oracle.kind === "new" ? { ...env, package: { ...env.package, version: pinTo } } : env;
        const moduleAbs = paths.moduleAbs ?? join(opts.root, opts.rec.module);
        const evidenceDir = dirname(paths.evidenceAbs);
        const standingPaths = standingTestPaths(opts.root, opts.pkg, opts.config.outDir);
        const standingAbs = standingPaths.tsAbs;
        const standingRel = standingPaths.tsRel;
        const hardenedAbs = join(opts.root, opts.rec.module.replace(/\.(ts|js|mjs|cjs)$/, ".hardened.test.ts"));
        txn.writeFile(moduleAbs, source);
        const runner = detectRunner(opts.root);
        const testRunner = runner.kind === "vitest" ? "vitest" : "node:test";
        txn.prepareWrite(standingAbs);
        txn.snapshot(join(opts.root, "package.json"));
        emitStandingTests({
            root: opts.root,
            outDir: opts.config.outDir,
            pkg: opts.pkg,
            env: envWrite,
            traces: env.traces,
            runner: testRunner,
            moduleSpecifier: toRelativeSpecifier(standingAbs, moduleAbs),
        });
        txn.prepareWrite(hardenedAbs);
        emitHardenedGetSetTest({ root: opts.root, moduleRel: opts.rec.module, runner: testRunner });
        txn.prepareWrite(join(evidenceDir, "evidence.md"));
        txn.prepareWrite(paths.evidenceAbs);
        const written = writeEvidence({
            root: opts.root,
            env: envWrite,
            replacementBytes: Buffer.byteLength(source),
            originalMin,
            fuzz: {
                cases: report.cases,
                comparisons: report.comparisons,
                timerCases: report.timerCases,
                tracesReplayed: report.tracesReplayed,
                wallMs: report.wallMs,
                seed: report.seed,
                disagreements: report.disagreements.length,
            },
            catalogIds: usedCatalog ? catalog.matched.map((m) => m.id) : [],
            coverageHoles: [],
            generation: usedCatalog
                ? {
                    kind: "catalog",
                    catalogIds: catalog.matched.map((m) => m.id),
                    attempts: 1,
                    specSource: "catalog",
                    counterexamples: [],
                }
                : {
                    kind: "llm",
                    catalogIds: [],
                    provider: llmCfg?.kind,
                    model: llmCfg?.model,
                    promptHash: gen?.promptHash,
                    attempts: 1,
                    specSource: pub?.source ?? "envelope-only",
                    limitation: pub?.limitation,
                    counterexamples: [],
                },
            revert: {
                package: envWrite.package.name,
                version: envWrite.package.version,
                module: opts.rec.module,
                tests: standingRel.replace(/\\/g, "/"),
                cjsCompanion: null,
                rewrites: [],
                lockfile: null,
                installCommand: "npm install",
            },
            dir: evidenceDir,
        });
        const disk = envelopeForDisk(envWrite);
        assertDocument("envelope", disk);
        txn.writeFile(paths.envelopeAbs, JSON.stringify(disk, null, 2) + "\n");
        const nextHash = hashEnvelope(envWrite);
        updateManifest(opts.root, opts.pkg, opts.rec, {
            envelopeHash: nextHash,
            version: oracle.kind === "new" ? pinTo : undefined,
        }, txn);
        if (oracle.kind === "new")
            bumpSlimJsonPin(opts.root, opts.pkg, pinTo, txn);
        standing(opts.root, opts.pkg, opts.config.outDir, undefined, Boolean(opts.args.json));
        hardened(opts.root, opts.rec.module, undefined, Boolean(opts.args.json));
        if (ownsTxn)
            txn.commit();
        return {
            pkg: opts.pkg,
            regenerated: true,
            usedCatalog,
            fuzzed: true,
            fuzzSkipReason: null,
            fuzz: {
                cases: report.cases,
                comparisons: report.comparisons,
                timerCases: report.timerCases,
            },
            hardenedTest: hardenedAbs,
            oracleKind: oracle.kind,
            oracleVersion: pinTo,
            residualRisk: written.residualRisk,
        };
    }
    catch (err) {
        if (ownsTxn)
            txn.rollback();
        throw err;
    }
    finally {
        if (srcTemp) {
            try {
                rmSync(srcTemp, { recursive: true, force: true });
            }
            catch {
                /* tmp */
            }
        }
        if (oracleTemp) {
            try {
                rmSync(oracleTemp, { recursive: true, force: true });
            }
            catch {
                /* tmp */
            }
        }
    }
}
export function advisoryAbstracts(findings) {
    const lines = [
        "Advisory abstracts (clean-room; OriginalSourceGuard: never ingest original .js):",
    ];
    for (const f of findings) {
        lines.push([f.id, f.summary, f.details].filter(Boolean).join("\n"));
    }
    return lines;
}
export function assertHardenedGetSet(fns) {
    const proto = Object.prototype;
    const before = Object.prototype.hasOwnProperty("polluted");
    delete proto.polluted;
    try {
        if (typeof fns.set === "function") {
            fns.set({}, "__proto__.polluted", true);
            fns.set({}, ["__proto__", "polluted"], true);
        }
        if (typeof fns.get === "function") {
            fns.get({ a: 1 }, "__proto__.polluted");
        }
        if (Object.prototype.hasOwnProperty("polluted") || proto.polluted !== undefined) {
            throw new SlimExit(EXIT_FAIL, "hardened get/set allowed Object.prototype pollution");
        }
        if (before !== Object.prototype.hasOwnProperty("polluted")) {
            throw new SlimExit(EXIT_FAIL, "hardened get/set allowed Object.prototype pollution");
        }
    }
    finally {
        delete proto.polluted;
    }
}
export { emitHardenedGetSetTest } from "../evidence/emit-tests.js";
export async function installUpstreamInTemp(name, version) {
    const spec = `${name}@${version}`;
    const view = spawnPm("npm", ["view", spec, "version"], {
        encoding: "utf8",
        timeout: 20_000,
        stdio: ["ignore", "pipe", "pipe"],
    });
    if (view.status !== 0)
        return null;
    const dir = mkdtempSync(join(tmpdir(), "slim-up-oracle-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "slim-upstream-oracle", private: true }));
    const inst = spawnPm("npm", ["install", spec, "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", dir], { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
    if (inst.status !== 0) {
        try {
            rmSync(dir, { recursive: true, force: true });
        }
        catch {
            /* keep */
        }
        return null;
    }
    return dir;
}
function usedSymbols(env, rec) {
    const fromEnv = env.symbols
        .map((s) => s.exportName)
        .filter((n) => n !== "*" && n !== "default" && n !== "(scan)");
    return fromEnv.length ? fromEnv : rec.symbols.filter((n) => n !== "*" && n !== "(scan)");
}
function stateOpts(opts) {
    return {
        outDir: opts.config.outDir,
        envelope: opts.config.replacements[opts.pkg]?.envelope,
    };
}
function loadEnvelope(opts) {
    const paths = resolveReplacementPaths(opts.root, opts.pkg, opts.rec, stateOpts(opts));
    return readDocument("envelope", paths.envelopeAbs, `envelope ${paths.envelopeAbs}`);
}
function loadTs(root) {
    try {
        return loadTargetTypescript(root);
    }
    catch {
        return loadTargetTypescript(slimRoot());
    }
}
async function resolveOracle(opts, deps, latest, symbols) {
    if (deps.loadOracle)
        return deps.loadOracle(opts.pkg, latest, symbols);
    const install = deps.installUpstream ?? installUpstreamInTemp;
    let tempDir;
    try {
        const dir = await install(opts.pkg, latest);
        if (dir) {
            tempDir = dir;
            const loaded = loadOriginalFromRoot(dir, opts.pkg, symbols);
            if (loaded)
                return { fns: loaded, kind: "new", tempDir };
        }
    }
    catch {
        /* fall back to pinned / project install */
    }
    if (tempDir) {
        try {
            rmSync(tempDir, { recursive: true, force: true });
        }
        catch {
            /* keep */
        }
    }
    const old = loadOriginalFromRoot(opts.root, opts.pkg, symbols);
    if (old)
        return { fns: old, kind: "old" };
    return null;
}
function loadOriginalFromRoot(root, pkg, symbols) {
    try {
        const req = createRequire(join(root, "package.json"));
        const mod = req(pkg);
        return pickFns(mod, symbols);
    }
    catch {
        return null;
    }
}
function pickFns(mod, symbols) {
    const out = {};
    const def = mod.default;
    for (const s of symbols) {
        const fn = (mod[s] ?? def?.[s]);
        if (typeof fn === "function")
            out[s] = fn;
    }
    return Object.keys(out).length ? out : null;
}
async function loadReplacementFns(absJs) {
    try {
        const href = pathToFileURL(absJs).href + `?slim=${Date.now()}`;
        const mod = (await import(__rewriteRelativeImportExtension(href)));
        return pickFns(mod, Object.keys(mod)) ?? pickFns(mod, ["get", "set", "default"]);
    }
    catch {
        return null;
    }
}
function isProtoPollutionCase(d) {
    const blob = `${d.symbol ?? ""} ${d.reason} ${JSON.stringify(d.args)}`;
    return /__proto__|prototype.?pollution|constructor\.prototype/i.test(blob);
}
function toRelativeSpecifier(fromFile, toFile) {
    let rel = relative(dirname(fromFile), toFile).replace(/\\/g, "/");
    if (!rel.startsWith("."))
        rel = "./" + rel;
    return rel;
}
function updateManifest(root, pkg, rec, next, txn) {
    rec.envelopeHash = next.envelopeHash;
    if (next.version)
        rec.version = next.version;
    const p = join(root, ".slim", "manifest.json");
    if (!existsSync(p))
        return;
    const man = JSON.parse(readFileSync(p, "utf8"));
    man.schemaVersion = 1;
    if (man.replacements?.[pkg]) {
        man.replacements[pkg] = {
            ...man.replacements[pkg],
            envelopeHash: next.envelopeHash,
            ...(next.version ? { version: next.version } : {}),
        };
        assertDocument("manifest", man);
        txn.writeFile(p, JSON.stringify(man, null, 2) + "\n");
    }
}
function bumpSlimJsonPin(root, pkg, version, txn) {
    const p = join(root, "slim.json");
    if (!existsSync(p))
        return;
    const slim = JSON.parse(readFileSync(p, "utf8"));
    if (slim.replacements?.[pkg]) {
        slim.replacements[pkg] = { ...slim.replacements[pkg], version };
        assertDocument("slim", slim);
        txn.writeFile(p, JSON.stringify(slim, null, 2) + "\n");
    }
}
//# sourceMappingURL=fix.js.map