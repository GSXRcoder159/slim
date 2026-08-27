import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SlimExit, EXIT_FAIL } from "../exit.ts";
import { pathEscapesRoot } from "../rewrite/paths.ts";

const IMPL_EXT = /\.(js|mjs|cjs)(\.map)?$/i;
const MAP_EXT = /\.map$/i;
const TEST_DIR = /\/(__tests__|tests?)\//;
const TEST_FILE = /\.(test|spec)\.[^/]+$/i;

/**
 * Generator must never ingest original implementation files.
 * .d.ts and README are API specs; .js under node_modules is not.
 */
export class OriginalSourceGuard {
  static assertNotOriginalImpl(filePath: string): void {
    const norm = filePath.replace(/\\/g, "/");
    if (!norm.includes("/node_modules/")) return;
    const base = norm.split("/").pop() ?? "";
    if (base === "package.json") return;
    if (/README(\.md)?$/i.test(base)) return;
    if (norm.endsWith(".d.ts")) return;
    if (IMPL_EXT.test(norm) || MAP_EXT.test(norm) || TEST_DIR.test(norm) || TEST_FILE.test(base)) {
      throw new SlimExit(
        EXIT_FAIL,
        `OriginalSourceGuard: refused to read ${filePath}`,
      );
    }
  }

  static readPublicSpec(filePath: string): string {
    if (!filePath.endsWith(".d.ts") && !/README(\.md)?$/i.test(filePath)) {
      throw new SlimExit(
        EXIT_FAIL,
        `OriginalSourceGuard: public spec must be .d.ts or README, got ${filePath}`,
      );
    }
    return guardedReadFileSync(filePath);
  }
}

/** Refuse metadata that is absolute or that resolves outside `allowedRoot`. */
export function assertDeclaredSpecInside(allowedRoot: string, rel: string): string {
  const clean = rel.split("?")[0]!;
  if (isAbsolute(clean)) {
    throw new SlimExit(EXIT_FAIL, `public spec escapes package root: ${rel}`);
  }
  return assertPublicSpecInside(allowedRoot, resolve(allowedRoot, clean));
}

/** Refuse symlink/traversal that leaves `allowedRoot`. `candidate` may already be absolute. */
export function assertPublicSpecInside(allowedRoot: string, candidate: string): string {
  const abs = isAbsolute(candidate) ? candidate : resolve(allowedRoot, candidate);
  if (pathEscapesRoot(allowedRoot, abs)) {
    throw new SlimExit(EXIT_FAIL, `public spec escapes package root: ${candidate}`);
  }
  return abs;
}

/** Generate/validate file reads. Fuzz workers may still import originals. */
export function guardedReadFileSync(filePath: string): string {
  OriginalSourceGuard.assertNotOriginalImpl(filePath);
  return readFileSync(filePath, "utf8");
}

export function slimRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "../..");
}

export function catalogRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "catalog");
}

export { existsSync };
