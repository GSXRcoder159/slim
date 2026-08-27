import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function standingTestPaths(
  root: string,
  pkg: string,
  outDir: string,
): { tsRel: string; jsRel: string; tsAbs: string; jsAbs: string } {
  const stem = `${pkg.replace(/\//g, "-")}.test`;
  const tsRel = join(outDir, `${stem}.ts`);
  const jsRel = join(outDir, `${stem}.js`);
  return { tsRel, jsRel, tsAbs: join(root, tsRel), jsAbs: join(root, jsRel) };
}

export function hardeningTestPaths(
  root: string,
  moduleRel: string,
): { tsRel: string; jsRel: string; tsAbs: string; jsAbs: string } {
  const base = moduleRel.replace(/\.(ts|js|mjs|cjs)$/, "");
  const tsRel = `${base}.hardened.test.ts`;
  const jsRel = `${base}.hardened.test.js`;
  return { tsRel, jsRel, tsAbs: join(root, tsRel), jsAbs: join(root, jsRel) };
}

export function evidenceScript(root: string): string | null {
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) return null;
  try {
    const json = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      scripts?: Record<string, string>;
    };
    return json.scripts?.["slim:evidence"]?.trim() || null;
  } catch {
    return null;
  }
}

export function hasStandingTests(root: string, pkg: string, outDir: string): boolean {
  if (evidenceScript(root)) return true;
  const paths = standingTestPaths(root, pkg, outDir);
  return existsSync(paths.tsAbs) || existsSync(paths.jsAbs);
}
