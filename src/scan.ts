import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import type { CliArgs } from "./cli.ts";
import { EXIT_OK, EXIT_USAGE } from "./exit.ts";
import { loadProject, type PackageJson } from "./project.ts";
import { loadConfig } from "./config.ts";
import { collectPackageSpecifiers, resolvePackageFamily } from "./analyze/index.ts";
import { parseSpecifier, resolvePackageImports } from "./analyze/family.ts";
import { estimatePackageSize, gzipGuess, readInstalledVersion } from "./size/estimate.ts";
import { refusePackage, BLOAT_PACKAGES } from "./scan/refuse.ts";
import { lockfileDirectDeps, type LockfileResult } from "./scan/lockfile-deps.ts";
import { envelopeForDisk } from "./envelope/types.ts";
import type { Envelope, ImportSite } from "./envelope/types.ts";
import { assertDocument } from "./schema/documents.ts";

export const SCAN_SCHEMA_VERSION = 2 as const;

export type VersionState = "exact" | "range-only" | "malformed" | "unavailable";
export type ScanRelation = "declared-imported" | "declared-unused" | "imported-undeclared";
export type DeclaredAs = "dependency" | "optional" | "peer" | "dev" | "none";
export type ScanVerdict = "candidate" | "review" | "refuse" | "unused";
export type SizeProvenance = "measured" | "estimated" | "unknown" | "partial";
export type SizeState = "measured" | "estimated" | "unknown" | "refused" | "review";

export interface ScanRow {
  name: string;
  family: string;
  subpaths: string[];
  importSites: number;
  typeOnlySites: number;
  version: string;
  versionState: VersionState;
  versionReason: string;
  relation: ScanRelation;
  declaredAs: DeclaredAs;
  verdict: ScanVerdict;
  slimmable: number;
  minBytes: number | null;
  gzipBytes: number | null;
  sizeProvenance: SizeProvenance;
  sizeState: SizeState;
  note: string;
}

export interface ScanReport {
  schemaVersion: typeof SCAN_SCHEMA_VERSION;
  lockfile: string | null;
  rows: ScanRow[];
}

const LOCAL_RANGE = /^(file|workspace|link|portal):/i;

type Declared = { range: string; declaredAs: Exclude<DeclaredAs, "none"> };

function declaredPackages(pkg: PackageJson): Map<string, Declared> {
  const out = new Map<string, Declared>();
  const add = (recs: Record<string, string> | undefined, declaredAs: Declared["declaredAs"]) => {
    for (const [name, range] of Object.entries(recs ?? {})) {
      if (typeof range === "string") out.set(name, { range, declaredAs });
    }
  };
  add(pkg.peerDependencies, "peer");
  add(pkg.devDependencies, "dev");
  add(pkg.optionalDependencies, "optional");
  add(pkg.dependencies, "dependency");
  return out;
}

function subpathsOf(name: string, sites: ImportSite[], importMap: unknown): string[] {
  const set = new Set<string>();
  for (const site of sites) {
    const resolved = resolvePackageImports(site.specifier, importMap) ?? site.specifier;
    const fam = resolvePackageFamily(resolved);
    const parsed = parseSpecifier(resolved);
    if (parsed?.name !== name && fam?.name !== name) continue;
    const sub = fam?.subpath || parsed?.subpath || "";
    if (sub) set.add(sub);
  }
  return [...set].sort();
}

function versionFor(
  name: string,
  declared: Declared | undefined,
  locked: LockfileResult,
  installed: string | null,
): { version: string; versionState: VersionState; versionReason: string } {
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

function rankVerdict(
  name: string,
  sites: number,
  minBytes: number | null,
  refuse: string | undefined,
  unused: boolean,
): { verdict: ScanVerdict; slimmable: number } {
  if (refuse) return { verdict: "refuse", slimmable: 0 };
  if (unused) return { verdict: "unused", slimmable: 0 };
  const interesting = BLOAT_PACKAGES.has(name) || (minBytes ?? 0) > 20_000;
  if (interesting && sites > 0 && sites <= 8) {
    return { verdict: "candidate", slimmable: 60 };
  }
  return { verdict: "review", slimmable: 20 };
}

export function scanProject(cwd = process.cwd()): ScanReport {
  const project = loadProject(cwd);
  const config = loadConfig(project.root);
  const { runtime: imports, typeOnly } = collectPackageSpecifiers(project, {
    include: config.include,
    ignore: config.ignore,
  });
  const declared = declaredPackages(project.packageJson);
  const locked = lockfileDirectDeps(project.root, project.lockfile);
  const names = new Set<string>();
  for (const name of declared.keys()) {
    if (name.startsWith("@types/")) continue;
    if (LOCAL_RANGE.test(declared.get(name)!.range)) continue;
    names.add(name);
  }
  for (const name of imports.keys()) {
    if (name.startsWith("@types/")) continue;
    const rec = declared.get(name);
    if (rec && LOCAL_RANGE.test(rec.range)) continue;
    names.add(name);
  }

  const rows: ScanRow[] = [];
  for (const name of [...names].sort()) {
    const fam = resolvePackageFamily(name);
    const sites = imports.get(name) ?? [];
    const unique = sites.length;
    const typeOnlySites = typeOnly.get(name)?.length ?? 0;
    const decl = declared.get(name);
    const unused = unique === 0 && Boolean(decl);
    const relation: ScanRelation = !decl
      ? "imported-undeclared"
      : unused
        ? "declared-unused"
        : "declared-imported";
    const size = estimatePackageSize(project.root, name);
    const refuse = refusePackage(name);
    const ver = versionFor(name, decl, locked, readInstalledVersion(project.root, name));
    const { verdict, slimmable } = rankVerdict(name, unique, size.minBytes, refuse?.why, unused);
    const sizeProvenance: SizeProvenance = size.source;
    const sizeState: SizeState =
      verdict === "refuse" ? "refused" : sizeProvenance === "partial" ? "review" : sizeProvenance;
    const note =
      refuse?.why ??
      (relation === "declared-unused" && typeOnlySites > 0
        ? "type-only imports only"
        : relation === "declared-unused"
          ? "declared but no import specifier"
          : relation === "imported-undeclared"
            ? "imported but not declared in package.json"
            : "");
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

export function scanReportJson(report: ScanReport): string {
  assertDocument("scan", report);
  return JSON.stringify(report, null, 2) + "\n";
}

export function formatScanHuman(report: ScanReport): string {
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
    lines.push(
      pad(r.name, 28) +
        pad(r.relation, 22) +
        pad(r.verdict, 12) +
        pad(String(r.importSites), 8) +
        pad(String(r.typeOnlySites), 8) +
        pad(min, 10) +
        pad(r.sizeProvenance, 12) +
        (r.note || ""),
    );
  }
  const n = report.rows.filter((r) => r.verdict === "candidate").length;
  lines.push("");
  lines.push(
    `${n} candidate${n === 1 ? "" : "s"}. Scan does not close an envelope. Run slim inspect <pkg> then slim replace <pkg>.`,
  );
  return lines.join("\n") + "\n";
}

export async function runScan(args: CliArgs): Promise<number> {
  const report = scanProject(args.pkg ?? process.cwd());
  if (args.json) {
    process.stdout.write(scanReportJson(report));
    return EXIT_OK;
  }
  process.stdout.write(formatScanHuman(report));
  return EXIT_OK;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n - 1) + " " : s + " ".repeat(n - s.length);
}

function fmtBytes(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}kB`;
  return `${n}B`;
}

export function writeEnvelope(root: string, pkg: string, env: Envelope): string {
  const dir = join(root, ".slim", pkg);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "envelope.json");
  const disk = envelopeForDisk(env);
  assertDocument("envelope", disk);
  writeFileSync(p, JSON.stringify(disk, null, 2) + "\n");
  return p;
}

export { existsSync, relative, EXIT_USAGE };
