import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { hasStandingTests, hardeningTestPaths, standingTestPaths } from "../evidence/paths.js";
import { fixtureRevision, hardeningSuiteBytes, sha256Bytes, sha256File, standingSuiteBytes, } from "../evidence/digests.js";
import { hashEnvelope } from "../envelope/types.js";
import { EXIT_FAIL, SlimExit } from "../exit.js";
import { checkContracts } from "../generate/exports.js";
import { validateGenerated } from "../generate/validate.js";
import { loadTargetTypescript } from "../project.js";
import { assertSafeStatePath, toPosixPath } from "../rewrite/paths.js";
import { readDocument } from "../schema/documents.js";
function sameSymbolSet(a, b) {
    if (a.length !== b.length)
        return false;
    const set = new Set(a);
    return b.every((s) => set.has(s));
}
function slimPin(root, pkg) {
    const p = join(root, "slim.json");
    if (!existsSync(p))
        return null;
    try {
        const slim = JSON.parse(readFileSync(p, "utf8"));
        const rec = slim.replacements?.[pkg];
        if (!rec?.version || !rec.module)
            return null;
        return { version: rec.version, module: rec.module };
    }
    catch {
        return null;
    }
}
function push(drift, kind, detail) {
    drift.push({ kind, detail });
}
function generationDrift(ev, pkg) {
    const g = ev.generation;
    if (!g)
        return [{ kind: "evidence", detail: `evidence.json for ${pkg} is missing generation` }];
    if (g.kind === "catalog" && (!Array.isArray(g.catalogIds) || g.catalogIds.length === 0)) {
        return [{ kind: "evidence", detail: `catalog evidence for ${pkg} requires catalogIds` }];
    }
    if (g.kind === "llm" && !g.provider) {
        return [{ kind: "evidence", detail: `llm evidence for ${pkg} requires provider` }];
    }
    return [];
}
function installedOracleVersion(root, pkg) {
    const abs = join(root, "node_modules", ...pkg.split("/"), "package.json");
    if (!existsSync(abs))
        return null;
    try {
        const json = JSON.parse(readFileSync(abs, "utf8"));
        if (typeof json.version !== "string" || !json.version)
            return false;
        return json.version;
    }
    catch {
        return false;
    }
}
function refuseAbsolute(raw) {
    if (isAbsolute(raw)) {
        throw new SlimExit(EXIT_FAIL, `unsafe state path: absolute path refused (${raw})`);
    }
}
function confinedJoin(root, rel) {
    refuseAbsolute(rel);
    const abs = join(root, rel);
    assertSafeStatePath(root, abs);
    return abs;
}
export function resolveReplacementPaths(root, pkg, rec, opts) {
    refuseAbsolute(opts.outDir);
    const configured = opts.envelope?.trim();
    if (configured)
        refuseAbsolute(configured);
    const envelopeRel = toPosixPath(configured || join(".slim", pkg, "envelope.json"));
    const envelopeAbs = confinedJoin(root, envelopeRel);
    const evidenceAbs = join(dirname(envelopeAbs), "evidence.json");
    assertSafeStatePath(root, evidenceAbs);
    const evidenceRel = toPosixPath(join(dirname(envelopeRel), "evidence.json"));
    const standing = standingTestPaths(root, pkg, opts.outDir);
    assertSafeStatePath(root, standing.tsAbs);
    assertSafeStatePath(root, standing.jsAbs);
    const moduleRel = rec?.module || opts.moduleFallback;
    let moduleAbs;
    if (moduleRel) {
        refuseAbsolute(moduleRel);
        moduleAbs = confinedJoin(root, moduleRel);
        const hardened = hardeningTestPaths(root, moduleRel);
        assertSafeStatePath(root, hardened.tsAbs);
        assertSafeStatePath(root, hardened.jsAbs);
    }
    return {
        envelopeAbs,
        envelopeRel,
        evidenceAbs,
        evidenceRel,
        ...(moduleRel ? { moduleRel, moduleAbs } : {}),
    };
}
function loadTs(root, ts) {
    if (ts)
        return ts;
    try {
        return loadTargetTypescript(root);
    }
    catch {
        return createRequire(import.meta.url)("typescript");
    }
}
function moduleSafetyDrift(root, pkg, moduleAbs, envelope, ts) {
    let source;
    try {
        source = readFileSync(moduleAbs, "utf8");
    }
    catch {
        return [{ kind: "exports", detail: `unreadable slice module for ${pkg}` }];
    }
    const drift = [];
    const ast = validateGenerated(ts, source, { envelope, fileName: moduleAbs });
    if (!ast.ok) {
        drift.push({
            kind: "ast",
            detail: `generated code failed AST allowlist: ${ast.errors.join("; ")}`,
        });
    }
    const contracts = checkContracts(ts, source, envelope);
    if (!contracts.ok) {
        for (const err of contracts.errors) {
            drift.push({ kind: "exports", detail: err });
        }
    }
    return drift;
}
function artifactDrift(root, pkg, outDir, moduleRel, ev, envelope, rec, pin) {
    const a = ev.artifacts;
    if (!a?.moduleDigest ||
        !a.standingDigest ||
        !a.hardeningDigest ||
        !a.oracleVersion ||
        !a.fixtureRevision) {
        return [{ kind: "evidence", detail: `evidence.json for ${pkg} is missing artifacts` }];
    }
    const drift = [];
    if (moduleRel && existsSync(join(root, moduleRel))) {
        const live = sha256File(join(root, moduleRel));
        if (live !== a.moduleDigest) {
            drift.push({ kind: "digest", detail: `evidence.json moduleDigest does not match module for ${pkg}` });
        }
    }
    const standing = standingSuiteBytes(root, pkg, outDir);
    if (standing && sha256Bytes(standing) !== a.standingDigest) {
        drift.push({ kind: "digest", detail: `evidence.json standingDigest does not match standing suite for ${pkg}` });
    }
    if (moduleRel) {
        const hardening = hardeningSuiteBytes(root, moduleRel);
        if (hardening && sha256Bytes(hardening) !== a.hardeningDigest) {
            drift.push({ kind: "digest", detail: `evidence.json hardeningDigest does not match hardening suite for ${pkg}` });
        }
        if (standing && hardening && fixtureRevision(standing, hardening) !== a.fixtureRevision) {
            drift.push({
                kind: "digest",
                detail: `evidence.json fixtureRevision does not match standing and hardening for ${pkg}`,
            });
        }
    }
    const want = a.oracleVersion;
    if (envelope && want !== envelope.package.version) {
        drift.push({
            kind: "version",
            detail: `evidence.json oracleVersion ${want} != envelope ${envelope.package.version}`,
        });
    }
    if (ev.package?.version && want !== ev.package.version) {
        drift.push({
            kind: "version",
            detail: `evidence.json oracleVersion ${want} != package ${ev.package.version}`,
        });
    }
    if (rec?.version && want !== rec.version) {
        drift.push({ kind: "version", detail: `evidence.json oracleVersion ${want} != manifest ${rec.version}` });
    }
    if (pin && want !== pin.version) {
        drift.push({ kind: "version", detail: `evidence.json oracleVersion ${want} != slim.json ${pin.version}` });
    }
    const installed = installedOracleVersion(root, pkg);
    if (installed === false) {
        drift.push({ kind: "version", detail: `installed ${pkg} package.json is unreadable` });
    }
    else if (installed && installed !== want) {
        drift.push({
            kind: "version",
            detail: `installed ${pkg}@${installed} != evidence oracleVersion ${want}`,
        });
    }
    return drift;
}
const MISSING_KINDS = new Set(["standing", "hardening"]);
function classifyKind(drift, missing, malformed) {
    if (malformed)
        return "malformed";
    if (missing)
        return "missing";
    if (!drift.length)
        return "ok";
    if (drift.every((d) => MISSING_KINDS.has(d.kind) || /^missing /.test(d.detail)))
        return "missing";
    return "malformed";
}
export function replacementStateIssues(root, pkg, rec, opts) {
    const drift = [];
    let residualRisk = [];
    let envelope = null;
    let fatal = null;
    let hash = null;
    let missing = false;
    let malformed = false;
    let paths = null;
    const miss = (kind, detail) => {
        missing = true;
        push(drift, kind, detail);
    };
    const bad = (kind, detail, err) => {
        malformed = true;
        if (err)
            fatal = fatal ?? err;
        push(drift, kind, detail);
    };
    try {
        paths = resolveReplacementPaths(root, pkg, rec, opts);
    }
    catch (err) {
        const msg = err instanceof SlimExit ? err.message : `unsafe state path for ${pkg}`;
        const fatalErr = err instanceof SlimExit ? err : new SlimExit(EXIT_FAIL, msg);
        return {
            envelope: null,
            residualRisk: [],
            drift: [{ kind: "path", detail: msg }],
            fatal: fatalErr,
            kind: "malformed",
            paths: null,
        };
    }
    if (!rec) {
        miss("manifest", `missing manifest replacement for ${pkg}`);
    }
    else if (!rec.version || !rec.envelopeHash || !Array.isArray(rec.symbols) || !rec.module) {
        bad("manifest", `malformed manifest replacement for ${pkg}`);
    }
    const envPath = paths.envelopeAbs;
    if (!existsSync(envPath)) {
        miss("envelope", `missing envelope ${envPath}`);
    }
    else {
        try {
            envelope = readDocument("envelope", envPath, `envelope ${envPath}`);
            if (envelope.package?.name !== pkg) {
                bad("envelope", `envelope package name mismatch in ${envPath}`);
            }
            try {
                hash = hashEnvelope(envelope);
            }
            catch {
                const err = new SlimExit(EXIT_FAIL, `malformed envelope ${envPath}`);
                bad("envelope", err.message, err);
            }
        }
        catch (err) {
            const msg = err instanceof SlimExit ? err.message : `malformed envelope ${envPath}`;
            bad("envelope", msg, err instanceof SlimExit ? err : new SlimExit(EXIT_FAIL, msg));
        }
    }
    if (rec && hash && rec.envelopeHash !== hash) {
        bad("hash", `manifest envelopeHash does not match envelope for ${pkg}`);
    }
    if (rec && envelope && rec.version !== envelope.package.version) {
        bad("version", `manifest version ${rec.version} != envelope ${envelope.package.version}`);
    }
    if (rec && envelope) {
        const envSymbols = envelope.symbols.map((s) => s.exportName);
        if (!sameSymbolSet(rec.symbols, envSymbols)) {
            bad("symbol", `manifest symbols do not match envelope for ${pkg}`);
        }
    }
    const pin = slimPin(root, pkg);
    if (pin && envelope && pin.version !== envelope.package.version) {
        bad("version", `slim.json version ${pin.version} != envelope ${envelope.package.version}`);
    }
    if (pin && rec && pin.module !== rec.module) {
        bad("exports", `slim.json module ${pin.module} != manifest ${rec.module}`);
    }
    const evidencePath = paths.evidenceAbs;
    let evidence = null;
    if (!existsSync(evidencePath)) {
        miss("evidence", `missing evidence ${evidencePath}`);
    }
    else {
        try {
            evidence = readDocument("evidence", evidencePath, "evidence.json");
            if (hash && evidence.envelopeHash !== hash) {
                bad("hash", `evidence.json envelopeHash does not match envelope for ${pkg}`);
            }
            if (envelope && evidence.package?.name && evidence.package.name !== envelope.package.name) {
                bad("evidence", `evidence.json package name mismatch for ${pkg}`);
            }
            if (envelope && evidence.package?.version && evidence.package.version !== envelope.package.version) {
                bad("version", `evidence.json version ${evidence.package.version} != envelope ${envelope.package.version}`);
            }
            residualRisk = Array.isArray(evidence.residualRisk) ? evidence.residualRisk.map(String) : [];
            for (const d of generationDrift(evidence, pkg))
                bad(d.kind, d.detail);
        }
        catch (err) {
            const msg = err instanceof SlimExit ? err.message : `malformed evidence ${evidencePath}`;
            bad("evidence", msg, err instanceof SlimExit ? err : new SlimExit(EXIT_FAIL, msg));
        }
    }
    const moduleRel = paths.moduleRel;
    if (!moduleRel) {
        miss("exports", `missing slice module`);
    }
    else {
        const moduleAbs = paths.moduleAbs;
        if (!existsSync(moduleAbs)) {
            miss("exports", `missing slice module ${moduleRel}`);
        }
        const hardened = hardeningTestPaths(root, moduleRel);
        if (!existsSync(hardened.tsAbs) && !existsSync(hardened.jsAbs)) {
            miss("hardening", `missing hardening tests for ${moduleRel}`);
        }
    }
    if (!hasStandingTests(root, pkg, opts.outDir)) {
        const standing = standingTestPaths(root, pkg, opts.outDir);
        miss("standing", `missing standing tests for ${pkg} (${standing.tsRel})`);
    }
    if (evidence) {
        for (const d of artifactDrift(root, pkg, opts.outDir, moduleRel, evidence, envelope, rec, pin)) {
            bad(d.kind, d.detail);
        }
    }
    if (envelope && paths.moduleAbs && existsSync(paths.moduleAbs)) {
        for (const d of moduleSafetyDrift(root, pkg, paths.moduleAbs, envelope, loadTs(root, opts.ts))) {
            bad(d.kind, d.detail);
        }
    }
    return {
        envelope,
        residualRisk,
        drift,
        fatal,
        kind: classifyKind(drift, missing, malformed),
        paths,
    };
}
export function assertReplacementState(root, pkg, rec, opts) {
    const state = replacementStateIssues(root, pkg, rec, opts);
    if (state.kind !== "ok" || state.drift.length || !state.envelope) {
        throw state.fatal ?? new SlimExit(EXIT_FAIL, state.drift[0]?.detail ?? `incomplete replacement state for ${pkg}`);
    }
    return state.envelope;
}
//# sourceMappingURL=state.js.map