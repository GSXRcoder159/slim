/**
 * Legal similarity gate: catalog sources and checked-in fixture slices must
 * not share long n-grams with pinned oracle implementation files.
 * Missing oracle trees fail closed. Moment locale *data* is classified
 * excluded (unsupported). Locale *engine* and lodash fp/ are scanned.
 * Unexplained skips fail.
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOG_ORACLES } from "../src/generate/catalog/oracles.ts";
import { LODASH_SYMBOLS } from "../src/generate/catalog/lodash-names.ts";

export const NGRAM_N = 12;
export const MAX_HITS = 3;
export const GOLDEN_SLICE = "fixtures/lodash-get-debounce/src/slim/lodash.ts";

export function requiredTargetRels(): string[] {
  const lodashFiles = [
    ...new Set(LODASH_SYMBOLS.map((s) => (s === "first" ? "head" : s))),
  ].map((s) => `src/generate/catalog/lodash.${s}.ts`);
  return [
    "src/generate/catalog/_internal.ts",
    "src/generate/catalog/index.ts",
    "src/generate/catalog/lodash-names.ts",
    "src/generate/catalog/oracles.ts",
    "src/generate/catalog/boundary.ts",
    "src/generate/catalog/lodash.ts",
    ...lodashFiles,
    "src/generate/catalog/moment.ts",
    "src/generate/catalog/uuid.ts",
    "src/generate/catalog/ms.ts",
    "src/generate/catalog/nanoid.ts",
    "src/generate/catalog/clsx.ts",
    "src/generate/catalog/whatwgUrl.ts",
    "src/generate/catalog/bluebird.ts",
    "src/generate/catalog/mimeTypes.ts",
    GOLDEN_SLICE,
  ].sort();
}

export const ORACLE_PATH_POLICY = [
  { pkg: "moment", prefix: "locale/", class: "intentionally-excluded" },
  { pkg: "moment", prefix: "src/locale/", class: "intentionally-excluded" },
  { pkg: "moment", prefix: "dist/locale/", class: "intentionally-excluded" },
  { pkg: "moment", prefix: "min/locales.js", class: "intentionally-excluded" },
  { pkg: "moment", prefix: "min/locales.min.js", class: "intentionally-excluded" },
  { pkg: "moment", prefix: "min/moment-with-locales.js", class: "intentionally-excluded" },
  { pkg: "moment", prefix: "min/moment-with-locales.min.js", class: "intentionally-excluded" },
] as const;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const ORACLE_PKGS = [...new Set(Object.keys(CATALOG_ORACLES))];

export function exclusionIds(): string[] {
  return ORACLE_PATH_POLICY.map((p) => `${p.pkg}:${p.prefix}`).sort();
}

function posix(p: string): string {
  return p.replace(/\\/g, "/");
}

function matchesPrefix(rel: string, prefix: string): boolean {
  const n = posix(rel);
  const p = posix(prefix);
  if (p.endsWith("/")) return n === p.slice(0, -1) || n.startsWith(p);
  return n === p;
}

function policyMatch(pkg: string, rel: string): (typeof ORACLE_PATH_POLICY)[number] | undefined {
  return ORACLE_PATH_POLICY.find((row) => row.pkg === pkg && matchesPrefix(rel, row.prefix));
}

function tokens(src: string): string[] {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/.*$/gm, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

function ngrams(toks: string[], n: number): Set<string> {
  const s = new Set<string>();
  for (let i = 0; i + n <= toks.length; i++) s.add(toks.slice(i, i + n).join(" "));
  return s;
}

function walkFiles(
  dir: string,
  pred: (f: string) => boolean,
  acc: string[] = [],
): string[] {
  if (!existsSync(dir)) return acc;
  const names = readdirSync(dir).slice().sort();
  for (const e of names) {
    if (e === "node_modules") continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walkFiles(p, pred, acc);
    else if (pred(p)) acc.push(p);
  }
  return acc;
}

function oracleFile(path: string): boolean {
  return path.endsWith(".js") || path.endsWith(".cjs") || path.endsWith(".mjs");
}

function sliceFile(path: string): boolean {
  const n = posix(path);
  return /\/src\/slim\/[^/]+\.(ts|js)$/.test(n);
}

function collectOracle(
  pkgDir: string,
  pkg: string,
): { files: string[]; matched: Set<string> } {
  const matched = new Set<string>();
  const files: string[] = [];
  const visit = (dir: string): void => {
    if (!existsSync(dir)) return;
    const names = readdirSync(dir).slice().sort();
    for (const e of names) {
      if (e === "node_modules") continue;
      const p = join(dir, e);
      const rel = posix(relative(pkgDir, p));
      const hit = policyMatch(pkg, rel);
      if (hit) {
        matched.add(`${hit.pkg}:${hit.prefix}`);
        continue;
      }
      const st = statSync(p);
      if (st.isDirectory()) visit(p);
      else if (oracleFile(p)) files.push(p);
    }
  };
  visit(pkgDir);
  files.sort();
  return { files, matched };
}

export function listOracleRels(opts?: { root?: string; oraclePkgs?: string[] }): string[] {
  const root = opts?.root ?? ROOT;
  const pkgs = opts?.oraclePkgs ?? ORACLE_PKGS;
  const out: string[] = [];
  for (const pkg of pkgs) {
    const dir = join(root, "node_modules", pkg);
    if (!existsSync(dir)) continue;
    const { files } = collectOracle(dir, pkg);
    for (const f of files) out.push(posix(join(pkg, relative(dir, f))));
  }
  return out.sort();
}

export function runSimilarityGate(opts?: {
  root?: string;
  oraclePkgs?: string[];
  requiredRels?: string[];
}): {
  ok: boolean;
  missing: string[];
  worst: number;
  worstFile: string;
  excluded: string[];
  targets: string[];
  failed?: string;
} {
  const root = opts?.root ?? ROOT;
  const pkgs = opts?.oraclePkgs ?? ORACLE_PKGS;
  const full = opts?.oraclePkgs == null;
  const catalog = walkFiles(join(root, "src/generate/catalog"), (f) => f.endsWith(".ts"));
  const slices = walkFiles(join(root, "fixtures"), sliceFile);
  const targets = [...catalog, ...slices].sort();
  const targetRels = targets.map((f) => posix(relative(root, f))).sort();
  const missing: string[] = [];
  const oracles: string[] = [];
  const matched = new Set<string>();
  const policyPkgs = new Set(ORACLE_PATH_POLICY.map((p) => p.pkg));
  for (const pkg of pkgs) {
    const dir = join(root, "node_modules", pkg);
    if (!existsSync(dir)) {
      missing.push(pkg);
      continue;
    }
    const got = collectOracle(dir, pkg);
    oracles.push(...got.files);
    for (const id of got.matched) matched.add(id);
  }
  oracles.sort();
  const excluded = [...matched].sort();
  const fail = (
    failed: string,
    extra?: Partial<{ missing: string[]; worst: number; worstFile: string; excluded: string[]; targets: string[] }>,
  ) => ({
    ok: false as const,
    missing: extra?.missing ?? missing,
    worst: extra?.worst ?? 0,
    worstFile: extra?.worstFile ?? "",
    excluded: extra?.excluded ?? excluded,
    targets: extra?.targets ?? targetRels,
    failed,
  });
  if (missing.length) {
    return fail(`similarity-gate FAIL: missing oracle tree(s): ${missing.join(", ")}`);
  }
  if (!oracles.length) {
    return fail("similarity-gate FAIL: no oracle implementation files found", { missing: pkgs });
  }
  if (!targets.length) {
    return fail("similarity-gate FAIL: no catalog or slice targets");
  }
  const required = opts?.requiredRels ?? (full ? requiredTargetRels() : []);
  for (const rel of required) {
    const abs = join(root, rel);
    if (!existsSync(abs) || !targetRels.includes(posix(rel))) {
      return fail(`similarity-gate FAIL: missing required target ${rel}`);
    }
  }
  if (full) {
    if (!catalog.length) {
      return fail("similarity-gate FAIL: empty catalog target set");
    }
    if (!existsSync(join(root, GOLDEN_SLICE))) {
      return fail(`similarity-gate FAIL: missing required golden slice ${GOLDEN_SLICE}`);
    }
  }
  const stale: string[] = [];
  for (const row of ORACLE_PATH_POLICY) {
    if (!pkgs.includes(row.pkg)) continue;
    if (!policyPkgs.has(row.pkg)) continue;
    const id = `${row.pkg}:${row.prefix}`;
    if (!matched.has(id)) stale.push(id);
  }
  if (stale.length) {
    return fail(`similarity-gate FAIL: stale exclusion matched nothing: ${stale.join(", ")}`);
  }

  const oracleGrams = new Set<string>();
  for (const f of oracles) {
    for (const g of ngrams(tokens(readFileSync(f, "utf8")), NGRAM_N)) oracleGrams.add(g);
  }

  let worst = 0;
  let worstFile = "";
  for (const f of targets) {
    const grams = [...ngrams(tokens(readFileSync(f, "utf8")), NGRAM_N)];
    const hits = grams.filter((g) => oracleGrams.has(g)).length;
    if (hits > worst) {
      worst = hits;
      worstFile = f;
    }
    if (hits > MAX_HITS) {
      return fail(`similarity-gate FAIL ${f}: ${hits} shared ${NGRAM_N}-grams with pinned oracles`, {
        worst: hits,
        worstFile: f,
      });
    }
  }
  return { ok: true, missing: [], worst, worstFile, excluded, targets: targetRels };
}
