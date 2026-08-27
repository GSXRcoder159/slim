import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { EXIT_FAIL, EXIT_USAGE, SlimExit } from "../exit.ts";

export function fileBase(name: string): string {
  return name.replace(/^@/, "").replace(/\//g, "-");
}

function existingAncestor(abs: string): string {
  let dir = resolve(abs);
  while (!existsSync(dir)) {
    const parent = dirname(dir);
    if (parent === dir) return dir;
    dir = parent;
  }
  return dir;
}

function isEnoent(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && (err as { code: string }).code === "ENOENT");
}

function rootReal(root: string): string {
  try {
    return realpathSync(existingAncestor(resolve(root)));
  } catch {
    return resolve(root);
  }
}

function symlinkDest(abs: string): string {
  try {
    return realpathSync(abs);
  } catch {
    return resolve(dirname(abs), readlinkSync(abs));
  }
}

/** True when `candidate` is outside `root` (symlink-aware). */
export function pathEscapesRoot(root: string, candidate: string): boolean {
  const absRoot = rootReal(root);
  const abs = resolve(candidate);
  let dest: string;
  try {
    dest = realpathSync(abs);
  } catch {
    const ancestor = existingAncestor(abs);
    let ancestorReal = ancestor;
    try {
      ancestorReal = realpathSync(ancestor);
    } catch {
      ancestorReal = resolve(ancestor);
    }
    dest = resolve(ancestorReal, relative(ancestor, abs));
  }
  const rel = relative(absRoot, dest);
  return rel.startsWith("..") || rel === ".." || isAbsolute(rel);
}

/** Resolve target and require it to stay inside root (symlink-aware). */
export function assertInsideRoot(root: string, target: string): string {
  const absRoot = resolve(root);
  const absTarget = resolve(absRoot, target);
  const rel = relative(rootReal(absRoot), realpathSync(existingAncestor(absTarget)));
  if (rel.startsWith("..") || rel === ".." || isAbsolute(rel)) {
    throw new SlimExit(EXIT_USAGE, `--out must stay inside the project root (got ${target})`);
  }
  if (absTarget === absRoot || absTarget.startsWith(absRoot + sep)) {
    return absTarget;
  }
  const relFromRoot = relative(absRoot, absTarget);
  if (relFromRoot.startsWith("..") || isAbsolute(relFromRoot)) {
    throw new SlimExit(EXIT_USAGE, `--out must stay inside the project root (got ${target})`);
  }
  return absTarget;
}

function posixRel(root: string, abs: string): string {
  return relative(resolve(root), resolve(abs)).replace(/\\/g, "/") || ".";
}

/** Refuse escaping symlinks, special files, and directory-as-file writes. */
export function assertSafeWrite(root: string, target: string): void {
  const absRoot = resolve(root);
  const abs = resolve(target);
  if (pathEscapesRoot(absRoot, abs)) {
    throw new SlimExit(EXIT_USAGE, `unsafe write: ${posixRel(absRoot, abs)} escapes the project`);
  }
  let cur = abs;
  for (;;) {
    let st;
    try {
      st = lstatSync(cur);
    } catch (err) {
      if (!isEnoent(err)) throw err;
      if (cur === absRoot || dirname(cur) === cur) break;
      cur = dirname(cur);
      continue;
    }
    if (st.isSymbolicLink()) {
      const dest = symlinkDest(cur);
      if (pathEscapesRoot(absRoot, dest)) {
        throw new SlimExit(EXIT_USAGE, `unsafe write: ${posixRel(absRoot, cur)} escapes the project`);
      }
    } else if (cur === abs) {
      if (st.isFIFO() || st.isSocket() || st.isCharacterDevice() || st.isBlockDevice()) {
        throw new SlimExit(EXIT_FAIL, `unsafe write: ${posixRel(absRoot, abs)} is a special file`);
      }
      if (st.isDirectory()) {
        throw new SlimExit(EXIT_FAIL, `unsafe write: ${posixRel(absRoot, abs)} is a directory`);
      }
    }
    if (cur === absRoot || dirname(cur) === cur) break;
    cur = dirname(cur);
  }
}

/** False when the path is missing, escaping, special, or a directory. */
export function isSafeToRewrite(root: string, file: string): boolean {
  try {
    lstatSync(resolve(file));
    assertSafeWrite(root, file);
    return true;
  } catch {
    return false;
  }
}

export function assertNoOutputCollision(
  root: string,
  slimPath: string,
  pkgName: string,
): void {
  const manifestPath = join(root, ".slim", "manifest.json");
  if (!existsSync(manifestPath) || !existsSync(slimPath)) return;
  let man: { replacements?: Record<string, { module?: string }> };
  try {
    man = JSON.parse(readFileSync(manifestPath, "utf8")) as typeof man;
  } catch {
    return;
  }
  const rel = relative(root, slimPath).replace(/\\/g, "/");
  for (const [name, rec] of Object.entries(man.replacements ?? {})) {
    if (name === pkgName) continue;
    const mod = (rec.module ?? "").replace(/\\/g, "/");
    if (mod === rel) {
      throw new SlimExit(
        EXIT_FAIL,
        `output collision: ${rel} already belongs to ${name}, not ${pkgName}`,
      );
    }
  }
}
