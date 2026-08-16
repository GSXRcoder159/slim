import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SlimExit, EXIT_FAIL } from "../exit.ts";

const IMPL_BASENAMES = new Set([
  "lodash.js",
  "lodash.min.js",
  "core.js",
  "moment.js",
]);

/**
 * Generator must never ingest original implementation files.
 * .d.ts and README are API specs; .js of lodash/moment is not.
 */
export class OriginalSourceGuard {
  static assertNotOriginalImpl(filePath: string): void {
    const norm = filePath.replace(/\\/g, "/");
    if (norm.includes("/node_modules/lodash/") && /\.(js|mjs|cjs)$/.test(norm)) {
      throw new SlimExit(
        EXIT_FAIL,
        `OriginalSourceGuard: refused to read lodash implementation ${filePath}`,
      );
    }
    if (norm.includes("/node_modules/moment/") && /\.(js|mjs|cjs)$/.test(norm)) {
      throw new SlimExit(
        EXIT_FAIL,
        `OriginalSourceGuard: refused to read moment implementation ${filePath}`,
      );
    }
    const base = norm.split("/").pop() ?? "";
    if (IMPL_BASENAMES.has(base) && norm.includes("/node_modules/")) {
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
