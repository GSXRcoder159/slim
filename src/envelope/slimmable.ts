import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Envelope, SlimmableVerdict } from "./types.ts";

export function scoreSlimmable(
  env: Envelope,
  opts?: { usedGraphPure?: boolean },
): Envelope["slimmable"] {
  const reasons: string[] = [];
  const blockers = [...env.slimmable.blockers];
  let score = 0;

  const refuseUnknown = env.unknowns.some((u) => u.widensTo === "refuse");
  if (refuseUnknown) {
    blockers.push("unknown site refuses this module");
  }
  if (env.slimmable.verdict === "refuse" && env.slimmable.blockers.length) {
    return { score: 0, verdict: "refuse", blockers, reasons: env.slimmable.reasons };
  }

  const usedGraphPure = opts?.usedGraphPure === true;
  if (usedGraphPure) {
    score += 40;
    reasons.push("used import graph has no .node/wasm/fs/net/eval");
  }
  if (env.unknowns.length === 0) {
    score += 20;
    reasons.push("no unknown sites");
  }
  const allTraced = env.symbols.every(
    (s) => s.callSites.length === 0 || s.coverage.callSitesTraced > 0,
  );
  if (allTraced && env.traces.length) {
    score += 15;
    reasons.push("all static call sites have traces");
  }
  if (env.symbols.length > 0 && env.symbols.length <= 3) {
    score += 10;
    reasons.push("≤3 symbols");
  }
  if (blockers.length) score -= 50;

  let verdict: SlimmableVerdict = "slim";
  if (blockers.length) verdict = "refuse";
  else if (score < 50 || env.unknowns.length) verdict = "review";

  return { score, verdict, blockers, reasons };
}

export function applySlimmable(env: Envelope, opts?: { usedGraphPure?: boolean }): Envelope {
  return { ...env, slimmable: scoreSlimmable(env, opts) };
}

const IMPURE_MODULE = /^(node:)?(fs|net)(\/|$)/;
const IMPURE_SRC = /\beval\s*\(|\bnew\s+Function\b|\bWebAssembly\b/;
const REQUIRE_SPEC = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const FROM_SPEC = /\bfrom\s+['"]([^'"]+)['"]/g;
const IMPORT_CALL_SPEC = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Walk used installed files (depth 8). Date.now is a seam, not impurity. */
export function usedSliceGraphPure(
  projectRoot: string,
  packageName: string,
  exportNames: string[],
): boolean {
  const pkgDir = join(projectRoot, "node_modules", packageName);
  if (!existsSync(pkgDir)) return false;
  const starts = symbolEntryFiles(pkgDir, exportNames);
  if (!starts.length) return false;

  const visited = new Set<string>();
  const queue: Array<{ file: string; depth: number }> = starts.map((file) => ({ file, depth: 0 }));
  while (queue.length) {
    const cur = queue.pop()!;
    if (visited.has(cur.file)) continue;
    visited.add(cur.file);
    if (cur.file.endsWith(".node") || cur.file.endsWith(".wasm")) return false;
    let text: string;
    try {
      text = readFileSync(cur.file, "utf8");
    } catch {
      continue;
    }
    if (IMPURE_SRC.test(text)) return false;
    if (cur.depth >= 8) continue;
    for (const spec of referencedSpecs(text)) {
      if (IMPURE_MODULE.test(spec)) return false;
      if (!spec.startsWith(".") && !spec.startsWith("/")) continue;
      const resolved = resolveRequireFile(cur.file, spec);
      if (resolved) queue.push({ file: resolved, depth: cur.depth + 1 });
    }
  }
  return visited.size > 0;
}

function symbolEntryFiles(pkgDir: string, exportNames: string[]): string[] {
  const out: string[] = [];
  for (const name of exportNames) {
    if (!name || name === "*" || name === "default" || name === "(scan)") continue;
    const cands = [
      join(pkgDir, `${name}.js`),
      join(pkgDir, `${name}.cjs`),
      join(pkgDir, `${name}.mjs`),
      join(pkgDir, name, "index.js"),
    ];
    const hit = cands.find((c) => existsSync(c));
    if (hit) out.push(hit);
  }
  if (!out.length) {
    const main = join(pkgDir, "index.js");
    if (existsSync(main)) out.push(main);
    else {
      try {
        const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as {
          main?: string;
        };
        if (pkg.main) {
          const p = join(pkgDir, pkg.main);
          if (existsSync(p)) out.push(p);
        }
      } catch {
        /* ignore */
      }
    }
  }
  return [...new Set(out)];
}

function referencedSpecs(text: string): string[] {
  const specs: string[] = [];
  for (const re of [REQUIRE_SPEC, FROM_SPEC, IMPORT_CALL_SPEC]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (m[1]) specs.push(m[1]);
    }
  }
  return specs;
}

function resolveRequireFile(fromFile: string, spec: string): string | null {
  const base = spec.startsWith("/") ? spec : join(dirname(fromFile), spec);
  const cands = [
    base,
    base + ".js",
    base + ".cjs",
    base + ".mjs",
    base + ".json",
    base + ".node",
    join(base, "index.js"),
  ];
  return cands.find((c) => existsSync(c)) ?? null;
}
