#!/usr/bin/env node
/**
 * Legal similarity gate: catalog/generated sources must not share long n-grams
 * with lodash/moment implementation files. Oracle packages are CI-only.
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const N = 12;
const MAX_HITS = 3;

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
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, pred, acc);
    else if (pred(p)) acc.push(p);
  }
  return acc;
}

const catalog = walk("src/generate/catalog", (f) => f.endsWith(".ts"));
const oracles = [
  ...walk("node_modules/lodash", (f) => f.endsWith(".js") && !f.includes("fp/")),
  ...walk("node_modules/moment", (f) => f.endsWith(".js") && !f.includes("locale")),
].slice(0, 40);

if (!oracles.length) {
  console.log("similarity-gate: no oracle sources (lodash/moment not installed); skip");
  process.exit(0);
}

const oracleGrams = new Set<string>();
for (const f of oracles) {
  for (const g of ngrams(tokens(readFileSync(f, "utf8")), N)) oracleGrams.add(g);
}

let worst = 0;
let worstFile = "";
for (const f of catalog) {
  const grams = [...ngrams(tokens(readFileSync(f, "utf8")), N)];
  const hits = grams.filter((g) => oracleGrams.has(g)).length;
  if (hits > worst) {
    worst = hits;
    worstFile = f;
  }
  if (hits > MAX_HITS) {
    console.error(`similarity-gate FAIL ${f}: ${hits} shared ${N}-grams with lodash/moment`);
    process.exit(1);
  }
}
console.log(`similarity-gate ok (worst ${worst} hits in ${worstFile || "none"})`);
