/**
 * Legal similarity gate: catalog sources must not share long n-grams with
 * pinned oracle implementation files. Missing oracle trees fail closed.
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOG_ORACLES } from "../src/generate/catalog/oracles.ts";

export const NGRAM_N = 12;
export const MAX_HITS = 3;

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

function walk(dir: string, pred: (f: string) => boolean, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "locale" || e === "fp") continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, pred, acc);
    else if (pred(p)) acc.push(p);
  }
  return acc;
}

function oracleFile(path: string): boolean {
  return path.endsWith(".js") || path.endsWith(".cjs") || path.endsWith(".mjs");
}

export function runSimilarityGate(opts?: {
  root?: string;
  oraclePkgs?: string[];
}): {
  ok: boolean;
  missing: string[];
  worst: number;
  worstFile: string;
  failed?: string;
} {
  const root = opts?.root ?? ROOT;
  const pkgs = opts?.oraclePkgs ?? ORACLE_PKGS;
  const catalog = walk(join(root, "src/generate/catalog"), (f) => f.endsWith(".ts"));
  const missing: string[] = [];
  const oracles: string[] = [];
  for (const pkg of pkgs) {
    const dir = join(root, "node_modules", pkg);
    if (!existsSync(dir)) {
      missing.push(pkg);
      continue;
    }
    oracles.push(...walk(dir, oracleFile));
  }
  if (missing.length) {
    return {
      ok: false,
      missing,
      worst: 0,
      worstFile: "",
      failed: `similarity-gate FAIL: missing oracle tree(s): ${missing.join(", ")}`,
    };
  }
  if (!oracles.length) {
    return {
      ok: false,
      missing: pkgs,
      worst: 0,
      worstFile: "",
      failed: "similarity-gate FAIL: no oracle implementation files found",
    };
  }

  const oracleGrams = new Set<string>();
  for (const f of oracles) {
    for (const g of ngrams(tokens(readFileSync(f, "utf8")), NGRAM_N)) oracleGrams.add(g);
  }

  let worst = 0;
  let worstFile = "";
  for (const f of catalog) {
    const grams = [...ngrams(tokens(readFileSync(f, "utf8")), NGRAM_N)];
    const hits = grams.filter((g) => oracleGrams.has(g)).length;
    if (hits > worst) {
      worst = hits;
      worstFile = f;
    }
    if (hits > MAX_HITS) {
      return {
        ok: false,
        missing: [],
        worst,
        worstFile,
        failed: `similarity-gate FAIL ${f}: ${hits} shared ${NGRAM_N}-grams with pinned oracles`,
      };
    }
  }
  return { ok: true, missing: [], worst, worstFile };
}
