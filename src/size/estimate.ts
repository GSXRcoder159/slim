import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";

/** Catalog estimated mins. gzipGuess is 0.36 × min. Regenerated via `npm run measure:claims`. */
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
  source: "estimated" | "measured" | "unknown" | "partial";
  unpackedBytes: number | null;
  reason: string;
}

export interface DirSize {
  bytes: number;
  complete: boolean;
  reason: string;
}

function confined(rootReal: string, target: string): boolean {
  return target === rootReal || target.startsWith(rootReal + sep);
}

export function dirSize(path: string, capFiles = 4000): DirSize {
  let total = 0;
  let n = 0;
  let complete = true;
  let reason = "";
  const mark = (why: string) => {
    complete = false;
    if (!reason) reason = why;
  };
  let rootReal = path;
  try {
    rootReal = realpathSync(path);
  } catch {
    return { bytes: 0, complete: false, reason: "unreadable directory" };
  }
  const stack = [path];
  while (stack.length) {
    const d = stack.pop()!;
    let ents;
    try {
      ents = readdirSync(d, { withFileTypes: true });
    } catch {
      mark("unreadable directory");
      continue;
    }
    ents.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of ents) {
      if (n++ >= capFiles) {
        mark("file cap");
        return { bytes: total, complete, reason };
      }
      const p = join(d, e.name);
      if (e.isSymbolicLink()) {
        let real: string;
        let st;
        try {
          real = realpathSync(p);
          st = statSync(p);
        } catch {
          mark("unreadable symlink");
          continue;
        }
        if (st.isDirectory()) {
          if (!confined(rootReal, real)) {
            mark("symlink escapes package");
            continue;
          }
          if (e.name === "node_modules") continue;
          stack.push(p);
        } else {
          if (!confined(rootReal, real)) {
            mark("symlink escapes package");
            continue;
          }
          total += st.size;
        }
        continue;
      }
      if (e.isDirectory()) {
        if (e.name === "node_modules") continue;
        stack.push(p);
      } else {
        try {
          total += statSync(p).size;
        } catch {
          mark("unreadable file");
        }
      }
    }
  }
  return { bytes: total, complete, reason };
}

export function estimatePackageSize(
  projectRoot: string,
  name: string,
  opts: { capFiles?: number } = {},
): SizeEstimate {
  const known = KNOWN_MIN_BYTES[name];
  const nm = join(projectRoot, "node_modules", name);
  if (!existsSync(nm)) {
    return { minBytes: known ?? null, source: "unknown", unpackedBytes: null, reason: "not installed" };
  }
  const walked = dirSize(nm, opts.capFiles ?? 4000);
  if (!walked.complete) {
    return {
      minBytes: known ?? walked.bytes,
      source: "partial",
      unpackedBytes: walked.bytes,
      reason: walked.reason,
    };
  }
  if (known != null) {
    return { minBytes: known, source: "estimated", unpackedBytes: walked.bytes, reason: "" };
  }
  return { minBytes: walked.bytes, source: "measured", unpackedBytes: walked.bytes, reason: "" };
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
