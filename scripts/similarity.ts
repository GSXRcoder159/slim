/**
 * Legal similarity gate: catalog sources and checked-in fixture slices must
 * not share long n-grams with pinned oracle implementation files.
 * Missing oracle trees fail closed. locale/ is skipped as data tables and
 * reported; lodash fp/ is scanned.
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOG_ORACLES } from "../src/generate/catalog/oracles.ts";

export const NGRAM_N = 12;
export const MAX_HITS = 3;
/** Data tables, not implementation. Always reported so a skip cannot hide. */
export const SKIPPED_ORACLE_DIRS = ["locale"] as const;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const ORACLE_PKGS = [...new Set(Object.keys(CATALOG_ORACLES))];

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

function walk(
  dir: string,
  pred: (f: string) => boolean,
  skipDirs: ReadonlySet<string>,
  acc: string[] = [],
): string[] {
  if (!existsSync(dir)) return acc;
  const names = readdirSync(dir).slice().sort();
  for (const e of names) {
    if (e === "node_modules" || skipDirs.has(e)) continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, pred, skipDirs, acc);
    else if (pred(p)) acc.push(p);
  }
  return acc;
}

function oracleFile(path: string): boolean {
  return path.endsWith(".js") || path.endsWith(".cjs") || path.endsWith(".mjs");
}

function sliceFile(path: string): boolean {
  const n = path.replace(/\\/g, "/");
  return /\/src\/slim\/[^/]+\.(ts|js)$/.test(n);
}

export function runSimilarityGate(opts?: {
  root?: string;
  oraclePkgs?: string[];
}): {
  ok: boolean;
  missing: string[];
  worst: number;
  worstFile: string;
  skipped: string[];
  failed?: string;
} {
  const root = opts?.root ?? ROOT;
  const pkgs = opts?.oraclePkgs ?? ORACLE_PKGS;
  const skipped = [...SKIPPED_ORACLE_DIRS];
  const catalog = walk(
    join(root, "src/generate/catalog"),
    (f) => f.endsWith(".ts"),
    new Set(),
  );
  const slices = walk(join(root, "fixtures"), sliceFile, new Set());
  const targets = [...catalog, ...slices].sort();
  const missing: string[] = [];
  const oracles: string[] = [];
  const oracleSkip = new Set<string>(SKIPPED_ORACLE_DIRS);
  for (const pkg of pkgs) {
    const dir = join(root, "node_modules", pkg);
    if (!existsSync(dir)) {
      missing.push(pkg);
      continue;
    }
    oracles.push(...walk(dir, oracleFile, oracleSkip));
  }
  oracles.sort();
  const fail = (failed: string, extra?: Partial<{ missing: string[]; worst: number; worstFile: string }>) => ({
    ok: false as const,
    missing: extra?.missing ?? missing,
    worst: extra?.worst ?? 0,
    worstFile: extra?.worstFile ?? "",
    skipped,
    failed,
  });
  if (missing.length) {
    return fail(`similarity-gate FAIL: missing oracle tree(s): ${missing.join(", ")}`);
  }
  if (!oracles.length) {
    return fail("similarity-gate FAIL: no oracle implementation files found", { missing: pkgs });
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
  return { ok: true, missing: [], worst, worstFile, skipped };
}
