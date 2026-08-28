/**
 * MIT License
 *
 * npm tarball identity: SHA-256 of packed member paths + bytes, not tar headers.
 * Action digest matches action/digest.mjs (wrappers + dist except the stamp).
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

export const STAMP_NAME = ".slim-build.json";

export const ACTION_WRAPPERS = [
  "action/check/action.yml",
  "action/bloat/action.yml",
  "action/upstream/action.yml",
  "action/run.mjs",
  "action/digest.mjs",
] as const;

function walkFiles(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkFiles(p, acc);
    else acc.push(p);
  }
  return acc;
}

/** Extract `package/` from an npm tarball into dest. Returns the package root. */
export function extractNpmPack(tarball: string, dest: string): string {
  mkdirSync(dest, { recursive: true });
  execFileSync("tar", ["-xzf", tarball, "-C", dest]);
  const root = join(dest, "package");
  if (!existsSync(root)) {
    throw new Error(`tarball ${tarball} has no package/ directory`);
  }
  return root;
}

export function contentDigestOfDir(root: string): string {
  const files = walkFiles(root)
    .map((p) => relative(root, p).replace(/\\/g, "/"))
    .sort();
  const h = createHash("sha256");
  for (const f of files) {
    h.update(f);
    h.update("\0");
    h.update(readFileSync(join(root, f)));
  }
  return h.digest("hex");
}

export function npmContentDigest(tarball: string): string {
  const dest = mkdtempSync(join(tmpdir(), "slim-npm-digest-"));
  try {
    const root = extractNpmPack(tarball, dest);
    return contentDigestOfDir(root);
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
}

export function actionDigestFromPack(packageRoot: string): string {
  const files: string[] = [...ACTION_WRAPPERS];
  const dist = join(packageRoot, "dist");
  for (const p of walkFiles(dist)) {
    const rel = relative(packageRoot, p).replace(/\\/g, "/");
    if (rel === `dist/${STAMP_NAME}`) continue;
    files.push(rel);
  }
  files.sort();
  const h = createHash("sha256");
  for (const f of files) {
    h.update(f);
    h.update("\0");
    h.update(readFileSync(join(packageRoot, f)));
  }
  return h.digest("hex");
}

export function stampActionSha256(packageRoot: string): string | null {
  const stamp = readStamp(packageRoot);
  return stamp?.actionSha256 ?? null;
}

export function stampDistSha256(packageRoot: string): string | null {
  const stamp = readStamp(packageRoot);
  return stamp?.sha256 ?? null;
}

export function readStamp(packageRoot: string): { sha256?: string; actionSha256?: string } | null {
  const stampPath = join(packageRoot, "dist", STAMP_NAME);
  if (!existsSync(stampPath)) return null;
  try {
    const stamp = JSON.parse(readFileSync(stampPath, "utf8")) as {
      sha256?: unknown;
      actionSha256?: unknown;
    };
    return {
      sha256: typeof stamp.sha256 === "string" ? stamp.sha256 : undefined,
      actionSha256: typeof stamp.actionSha256 === "string" ? stamp.actionSha256 : undefined,
    };
  } catch {
    return null;
  }
}

export interface ArtifactIdentity {
  schemaVersion: 1;
  commit: string;
  npmDigest: string;
  actionDigest: string;
  distSha256: string;
  packedAt: string;
}

export function artifactIdentity(opts: {
  commit: string;
  npmDigest: string;
  actionDigest: string;
  distSha256: string;
  packedAt?: string;
}): ArtifactIdentity {
  return {
    schemaVersion: 1,
    commit: opts.commit,
    npmDigest: opts.npmDigest,
    actionDigest: opts.actionDigest,
    distSha256: opts.distSha256,
    packedAt: opts.packedAt ?? new Date().toISOString(),
  };
}
