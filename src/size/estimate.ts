import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Bundlephobia-ish min bytes for first-wave packages (2026-08-15). */
export const KNOWN_MIN_BYTES: Record<string, number> = {
  lodash: 71_000,
  "lodash-es": 71_000,
  moment: 60_600,
  "moment-timezone": 300_000,
  "whatwg-url": 470_900,
  "mime-types": 162_500,
  validator: 125_200,
  "cron-parser": 100_000,
  bluebird: 79_000,
  "date-fns": 72_100,
  "crypto-js": 65_600,
  "js-yaml": 57_600,
  ramda: 55_100,
  jsonwebtoken: 54_500,
  qs: 40_900,
  async: 21_900,
  uuid: 10_200,
  ms: 2_000,
  nanoid: 1_500,
  clsx: 800,
};

export interface SizeEstimate {
  minBytes: number | null;
  source: "estimated" | "measured" | "unknown";
  unpackedBytes: number | null;
}

export function dirSize(path: string, capFiles = 4000): number {
  let total = 0;
  let n = 0;
  const stack = [path];
  while (stack.length) {
    const d = stack.pop()!;
    let ents;
    try {
      ents = readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      if (n++ > capFiles) return total;
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules") continue;
        stack.push(p);
      } else {
        try {
          total += statSync(p).size;
        } catch {
          /* ignore */
        }
      }
    }
  }
  return total;
}

export function estimatePackageSize(projectRoot: string, name: string): SizeEstimate {
  const known = KNOWN_MIN_BYTES[name];
  const nm = join(projectRoot, "node_modules", name);
  let unpacked: number | null = null;
  if (existsSync(nm)) unpacked = dirSize(nm);
  if (known != null) {
    return { minBytes: known, source: "estimated", unpackedBytes: unpacked };
  }
  if (unpacked != null) {
    return { minBytes: unpacked, source: "measured", unpackedBytes: unpacked };
  }
  return { minBytes: null, source: "unknown", unpackedBytes: null };
}

export function gzipGuess(minBytes: number): number {
  return Math.round(minBytes * 0.36);
}

export function readInstalledVersion(projectRoot: string, name: string): string | null {
  const p = join(projectRoot, "node_modules", name, "package.json");
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, "utf8")) as { version?: string };
    return j.version ?? null;
  } catch {
    return null;
  }
}
