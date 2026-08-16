import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import type { CliArgs } from "./cli.ts";
import { EXIT_OK, EXIT_USAGE } from "./exit.ts";
import { loadProject } from "./project.ts";
import { loadConfig } from "./config.ts";
import { collectImportSpecifiers, resolvePackageFamily } from "./analyze/index.ts";
import { estimatePackageSize, gzipGuess } from "./size/estimate.ts";
import { refusePackage, BLOAT_PACKAGES } from "./scan/refuse.ts";
import { scoreSlimmable } from "./envelope/slimmable.ts";
import { ENVELOPE_VERSION, emptyHyrum } from "./envelope/types.ts";
import type { Envelope } from "./envelope/types.ts";

export interface ScanRow {
  name: string;
  version: string;
  family: string;
  importSites: number;
  minBytes: number | null;
  gzipBytes: number | null;
  slimmable: number;
  verdict: "slim" | "review" | "refuse" | "unused";
  note: string;
}

export interface ScanReport {
  root: string;
  lockfile: string | null;
  rows: ScanRow[];
}

export function scanProject(cwd = process.cwd()): ScanReport {
  const project = loadProject(cwd);
  const config = loadConfig(project.root);
  const imports = collectImportSpecifiers(project);
  const deps = {
    ...project.packageJson.dependencies,
    ...project.packageJson.optionalDependencies,
  };
  const names = new Set([...Object.keys(deps ?? {}), ...imports.keys()]);
  const rows: ScanRow[] = [];
  for (const name of [...names].sort()) {
    if (name.startsWith("@types/")) continue;
    const fam = resolvePackageFamily(name);
    const sites = [
      ...(imports.get(name) ?? []),
      ...(fam && fam.name !== name ? imports.get(fam.name) ?? [] : []),
    ];
    const unique = sites.length;
    const size = estimatePackageSize(project.root, name);
    const refuse = refusePackage(name);
    const version =
      (deps[name] ?? "").replace(/^[~^>=<\s]+/, "") || "unknown";
    const stubEnv: Envelope = {
      schemaVersion: ENVELOPE_VERSION,
      package: {
        name,
        version,
        family: fam?.family ?? name,
        subpath: fam?.subpath ?? "",
      },
      env: ["node"],
      imports: sites,
      symbols: unique
        ? [
            {
              exportName: "(scan)",
              packages: [],
              callSites: [],
              resultMembers: [],
              hyrum: emptyHyrum(),
              coverage: { callSitesStatic: unique, callSitesTraced: 0 },
            },
          ]
        : [],
      unknowns: [],
      traces: [],
      closure: {
        confidence: "open",
        readyToGenerate: false,
        untracedCallSiteIds: [],
        reason: "scan",
      },
      slimmable: {
        score: 0,
        verdict: refuse ? "refuse" : unique ? "review" : "review",
        blockers: refuse ? [refuse.why] : [],
        reasons: [],
      },
      clock: false,
      cryptoRandom: false,
    };
    const slim = scoreSlimmable(stubEnv);
    const unused = unique === 0 && Boolean(deps[name]);
    let verdict: ScanRow["verdict"] = slim.verdict;
    if (unused) verdict = "unused";
    if (refuse) verdict = "refuse";
    if (!refuse && unique > 0 && (BLOAT_PACKAGES.has(name) || (size.minBytes ?? 0) > 20_000)) {
      verdict = slim.verdict === "refuse" ? "refuse" : unique <= 8 ? "slim" : "review";
    }
    void config;
    rows.push({
      name,
      version,
      family: fam?.family ?? name,
      importSites: unique,
      minBytes: size.minBytes,
      gzipBytes: size.minBytes != null ? gzipGuess(size.minBytes) : null,
      slimmable: refuse ? 0 : unused ? 0 : verdict === "slim" ? Math.max(slim.score, 60) : slim.score,
      verdict,
      note: refuse?.why ?? (unused ? "declared but no import specifier" : ""),
    });
  }
  return { root: project.root, lockfile: project.lockfile, rows };
}

export async function runScan(args: CliArgs): Promise<number> {
  const report = scanProject();
  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return EXIT_OK;
  }
  process.stdout.write(
    pad("package", 28) +
      pad("verdict", 10) +
      pad("sites", 8) +
      pad("min", 10) +
      pad("score", 8) +
      "note\n",
  );
  for (const r of report.rows) {
    if (r.verdict === "unused" && r.importSites === 0 && !BLOAT_PACKAGES.has(r.name)) {
      continue;
    }
    const min = r.minBytes != null ? fmtBytes(r.minBytes) : "?";
    process.stdout.write(
      pad(r.name, 28) +
        pad(r.verdict, 10) +
        pad(String(r.importSites), 8) +
        pad(min, 10) +
        pad(String(r.slimmable), 8) +
        (r.note || "") +
        "\n",
    );
  }
  process.stdout.write(
    `\n${report.rows.filter((r) => r.verdict === "slim").length} slimmable. Run slim inspect <pkg> then slim replace <pkg>.\n`,
  );
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
  writeFileSync(p, JSON.stringify(env, null, 2) + "\n");
  return p;
}

export { existsSync, relative, EXIT_USAGE };
