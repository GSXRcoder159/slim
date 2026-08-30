import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { EXIT_OK, EXIT_USAGE } from "./exit.js";
import { loadProject } from "./project.js";
import { loadConfig } from "./config.js";
import { collectPackageSpecifiers, resolvePackageFamily } from "./analyze/index.js";
import { parseSpecifier, resolvePackageImports } from "./analyze/family.js";
import { estimatePackageSize, gzipGuess, readInstalledVersion } from "./size/estimate.js";
import { refusePackage, BLOAT_PACKAGES } from "./scan/refuse.js";
import { lockfileDirectDeps } from "./scan/lockfile-deps.js";
import { envelopeForDisk } from "./envelope/types.js";
import { assertDocument } from "./schema/documents.js";
export const SCAN_SCHEMA_VERSION = 2;
const LOCAL_RANGE = /^(file|workspace|link|portal):/i;
function declaredPackages(pkg) {
    const out = new Map();
    const add = (recs, declaredAs) => {
        for (const [name, range] of Object.entries(recs ?? {})) {
            if (typeof range === "string")
                out.set(name, { range, declaredAs });
        }
    };
    add(pkg.peerDependencies, "peer");
    add(pkg.devDependencies, "dev");
    add(pkg.optionalDependencies, "optional");
    add(pkg.dependencies, "dependency");
    return out;
}
function subpathsOf(name, sites, importMap) {
    const set = new Set();
    for (const site of sites) {
        const resolved = resolvePackageImports(site.specifier, importMap) ?? site.specifier;
        const fam = resolvePackageFamily(resolved);
        const parsed = parseSpecifier(resolved);
        if (parsed?.name !== name && fam?.name !== name)
            continue;
        const sub = fam?.subpath || parsed?.subpath || "";
        if (sub)
            set.add(sub);
    }
    return [...set].sort();
}
function versionFor(name, declared, locked, installed) {
    if (locked.state === "malformed") {
        return { version: "unknown", versionState: "malformed", versionReason: locked.reason };
    }
    const exact = locked.versions.get(name) ?? installed;
    if (exact) {
        return { version: exact, versionState: "exact", versionReason: "" };
    }
    if (locked.state === "unavailable") {
        return { version: "unknown", versionState: "unavailable", versionReason: locked.reason };
    }
    if (declared?.range && !LOCAL_RANGE.test(declared.range)) {
        return {
            version: "unknown",
            versionState: "range-only",
            versionReason: `package.json range only (${declared.range})`,
        };
    }
    return {
        version: "unknown",
        versionState: "unavailable",
        versionReason: "no lockfile version or package.json range",
    };
}
function rankVerdict(name, sites, minBytes, refuse, unused) {
    if (refuse)
        return { verdict: "refuse", slimmable: 0 };
    if (unused)
        return { verdict: "unused", slimmable: 0 };
    const interesting = BLOAT_PACKAGES.has(name) || (minBytes ?? 0) > 20_000;
    if (interesting && sites > 0 && sites <= 8) {
        return { verdict: "candidate", slimmable: 60 };
    }
    return { verdict: "review", slimmable: 20 };
}
export function scanProject(cwd = process.cwd()) {
    const project = loadProject(cwd);
    const config = loadConfig(project.root);
    const { runtime: imports, typeOnly } = collectPackageSpecifiers(project, {
        include: config.include,
        ignore: config.ignore,
    });
    const declared = declaredPackages(project.packageJson);
    const locked = lockfileDirectDeps(project.root, project.lockfile);
    const names = new Set();
    for (const name of declared.keys()) {
        if (name.startsWith("@types/"))
            continue;
        if (LOCAL_RANGE.test(declared.get(name).range))
            continue;
        names.add(name);
    }
    for (const name of imports.keys()) {
        if (name.startsWith("@types/"))
            continue;
        const rec = declared.get(name);
        if (rec && LOCAL_RANGE.test(rec.range))
            continue;
        names.add(name);
    }
    const rows = [];
    for (const name of [...names].sort()) {
        const fam = resolvePackageFamily(name);
        const sites = imports.get(name) ?? [];
        const unique = sites.length;
        const typeOnlySites = typeOnly.get(name)?.length ?? 0;
        const decl = declared.get(name);
        const unused = unique === 0 && Boolean(decl);
        const relation = !decl
            ? "imported-undeclared"
            : unused
                ? "declared-unused"
                : "declared-imported";
        const size = estimatePackageSize(project.root, name);
        const refuse = refusePackage(name);
        const ver = versionFor(name, decl, locked, readInstalledVersion(project.root, name));
        const { verdict, slimmable } = rankVerdict(name, unique, size.minBytes, refuse?.why, unused);
        const sizeProvenance = size.source;
        const sizeState = verdict === "refuse" ? "refused" : sizeProvenance === "partial" ? "review" : sizeProvenance;
        let note = refuse?.why ??
            (relation === "declared-unused" && typeOnlySites > 0
                ? "type-only imports only"
                : relation === "declared-unused"
                    ? "declared but no import specifier"
                    : relation === "imported-undeclared"
                        ? "imported but not declared in package.json"
                        : "");
        if ((sizeProvenance === "partial" || sizeProvenance === "unknown") && size.reason) {
            note = note ? `${note}; ${size.reason}` : size.reason;
        }
        rows.push({
            name,
            family: fam?.family ?? name,
            subpaths: subpathsOf(name, sites, project.packageJson.imports),
            importSites: unique,
            typeOnlySites,
            version: ver.version,
            versionState: ver.versionState,
            versionReason: ver.versionReason,
            relation,
            declaredAs: decl?.declaredAs ?? "none",
            verdict,
            slimmable,
            minBytes: size.minBytes,
            gzipBytes: size.minBytes != null ? gzipGuess(size.minBytes) : null,
            sizeProvenance,
            sizeState,
            note,
        });
    }
    return { schemaVersion: SCAN_SCHEMA_VERSION, lockfile: project.lockfile, rows };
}
export function scanReportJson(report) {
    assertDocument("scan", report);
    return JSON.stringify(report, null, 2) + "\n";
}
export function formatScanHuman(report) {
    const lines = [
        pad("package", 28) +
            pad("relation", 22) +
            pad("verdict", 12) +
            pad("sites", 8) +
            pad("types", 8) +
            pad("min", 10) +
            pad("size", 12) +
            "note",
    ];
    for (const r of report.rows) {
        const min = r.minBytes != null ? fmtBytes(r.minBytes) : "?";
        lines.push(pad(r.name, 28) +
            pad(r.relation, 22) +
            pad(r.verdict, 12) +
            pad(String(r.importSites), 8) +
            pad(String(r.typeOnlySites), 8) +
            pad(min, 10) +
            pad(r.sizeProvenance, 12) +
            (r.note || ""));
    }
    const n = report.rows.filter((r) => r.verdict === "candidate").length;
    lines.push("");
    lines.push(`${n} candidate${n === 1 ? "" : "s"}. Scan does not close an envelope. Run slim inspect <pkg> then slim replace <pkg>.`);
    return lines.join("\n") + "\n";
}
export async function runScan(args) {
    const report = scanProject(args.pkg ?? process.cwd());
    if (args.json) {
        process.stdout.write(scanReportJson(report));
        return EXIT_OK;
    }
    process.stdout.write(formatScanHuman(report));
    return EXIT_OK;
}
function pad(s, n) {
    return s.length >= n ? s.slice(0, n - 1) + " " : s + " ".repeat(n - s.length);
}
function fmtBytes(n) {
    if (n >= 1000)
        return `${(n / 1000).toFixed(1)}kB`;
    return `${n}B`;
}
export function writeEnvelope(root, pkg, env) {
    const dir = join(root, ".slim", pkg);
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "envelope.json");
    const disk = envelopeForDisk(env);
    assertDocument("envelope", disk);
    writeFileSync(p, JSON.stringify(disk, null, 2) + "\n");
    return p;
}
export { existsSync, relative, EXIT_USAGE };
//# sourceMappingURL=scan.js.map