import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { EXIT_FAIL, EXIT_USAGE, SlimExit } from "../exit.ts";

export function fileBase(name: string): string {
  return name.replace(/^@/, "").replace(/\//g, "-");
}

export function toPosixPath(p: string): string {
  return p.replace(/\\/g, "/");
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

function pathExists(abs: string): boolean {
  try {
    lstatSync(abs);
    return true;
  } catch (err) {
    if (isEnoent(err)) return false;
    throw err;
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

function posixRel(root: string, abs: string): string {
  return relative(resolve(root), resolve(abs)).replace(/\\/g, "/") || ".";
}

type HopKind = "out" | "write";

/** Refuse any symlink hop from `target` up to (not including) `root`. */
function assertNoSymlinkHop(root: string, target: string, kind: HopKind): void {
  const absRoot = resolve(root);
  const abs = resolve(target);
  let cur = abs;
  while (cur !== absRoot && dirname(cur) !== cur) {
    let st;
    try {
      st = lstatSync(cur);
    } catch (err) {
      if (!isEnoent(err)) throw err;
      cur = dirname(cur);
      continue;
    }
    if (st.isSymbolicLink()) {
      const dest = symlinkDest(cur);
      if (pathEscapesRoot(absRoot, dest)) {
        throw new SlimExit(
          EXIT_USAGE,
          kind === "out"
            ? `--out must stay inside the project root (got ${target})`
            : `unsafe write: ${posixRel(absRoot, cur)} escapes the project`,
        );
      }
      throw new SlimExit(
        EXIT_USAGE,
        kind === "out"
          ? `--out must not be a symlink (got ${target})`
          : `unsafe write: ${posixRel(absRoot, cur)} is a symlink`,
      );
    }
    cur = dirname(cur);
  }
}

/** Resolve target and require it to stay inside root (symlink-aware). */
export function assertInsideRoot(root: string, target: string): string {
  const absRoot = resolve(root);
  const absTarget = resolve(absRoot, target);
  const rel = relative(rootReal(absRoot), realpathSync(existingAncestor(absTarget)));
  if (rel.startsWith("..") || rel === ".." || isAbsolute(rel)) {
    throw new SlimExit(EXIT_USAGE, `--out must stay inside the project root (got ${target})`);
  }
  const relFromRoot = relative(absRoot, absTarget);
  if (!(absTarget === absRoot || absTarget.startsWith(absRoot + sep))) {
    if (relFromRoot.startsWith("..") || isAbsolute(relFromRoot)) {
      throw new SlimExit(EXIT_USAGE, `--out must stay inside the project root (got ${target})`);
    }
  }
  assertNoSymlinkHop(absRoot, absTarget, "out");
  return absTarget;
}

/** Refuse escaping/internal symlinks, special files, and directory-as-file writes. */
export function assertSafeWrite(root: string, target: string): void {
  const absRoot = resolve(root);
  const abs = resolve(target);
  if (pathEscapesRoot(absRoot, abs)) {
    throw new SlimExit(EXIT_USAGE, `unsafe write: ${posixRel(absRoot, abs)} escapes the project`);
  }
  assertNoSymlinkHop(absRoot, abs, "write");
  let st;
  try {
    st = lstatSync(abs);
  } catch (err) {
    if (isEnoent(err)) return;
    throw err;
  }
  if (st.isFIFO() || st.isSocket() || st.isCharacterDevice() || st.isBlockDevice()) {
    throw new SlimExit(EXIT_FAIL, `unsafe write: ${posixRel(absRoot, abs)} is a special file`);
  }
  if (st.isDirectory()) {
    throw new SlimExit(EXIT_FAIL, `unsafe write: ${posixRel(absRoot, abs)} is a directory`);
  }
}

/** False when the path is missing, escaping, a symlink, special, or a directory. */
export function isSafeToRewrite(root: string, file: string): boolean {
  try {
    lstatSync(resolve(file));
    assertSafeWrite(root, file);
    return true;
  } catch {
    return false;
  }
}

type ManifestRecord = {
  version?: unknown;
  envelopeHash?: unknown;
  symbols?: unknown;
  module?: unknown;
};

type ManifestFile = {
  schemaVersion?: unknown;
  replacements?: Record<string, ManifestRecord>;
};

function loadManifest(root: string): ManifestFile | "missing" | "malformed" {
  const manifestPath = join(root, ".slim", "manifest.json");
  if (!existsSync(manifestPath)) return "missing";
  try {
    const man = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
    if (man === null || typeof man !== "object" || Array.isArray(man)) return "malformed";
    return man as ManifestFile;
  } catch {
    return "malformed";
  }
}

function isAcceptedRecord(rec: ManifestRecord | undefined): rec is {
  version: string;
  envelopeHash: string;
  symbols: string[];
  module: string;
} {
  if (!rec) return false;
  return (
    typeof rec.version === "string" &&
    typeof rec.envelopeHash === "string" &&
    rec.envelopeHash.length === 64 &&
    Array.isArray(rec.symbols) &&
    rec.symbols.every((s) => typeof s === "string") &&
    typeof rec.module === "string"
  );
}

function posixModule(module: string): string {
  return module.replace(/\\/g, "/");
}

function ownsSlice(root: string, pkgName: string, sliceRel: string): boolean {
  const man = loadManifest(root);
  if (man === "missing" || man === "malformed") return false;
  if (man.schemaVersion !== 1) return false;
  const own = man.replacements?.[pkgName];
  return isAcceptedRecord(own) && posixModule(own.module) === sliceRel;
}

export function assertNoOutputCollision(root: string, slimPath: string, pkgName: string): void {
  if (!pathExists(slimPath)) return;
  const rel = posixRel(root, slimPath);
  const man = loadManifest(root);
  if (man === "missing" || man === "malformed" || man.schemaVersion !== 1) {
    throw new SlimExit(EXIT_FAIL, `output collision: ${rel} exists and is not a Slim-owned module for ${pkgName}`);
  }
  const replacements = man.replacements;
  if (!replacements || typeof replacements !== "object" || Array.isArray(replacements)) {
    throw new SlimExit(EXIT_FAIL, `output collision: ${rel} exists and is not a Slim-owned module for ${pkgName}`);
  }
  for (const [name, rec] of Object.entries(replacements)) {
    if (name === pkgName) continue;
    const mod = typeof rec?.module === "string" ? posixModule(rec.module) : "";
    if (mod === rel) {
      throw new SlimExit(EXIT_FAIL, `output collision: ${rel} already belongs to ${name}, not ${pkgName}`);
    }
  }
  const own = replacements[pkgName];
  if (isAcceptedRecord(own) && posixModule(own.module) === rel) return;
  throw new SlimExit(EXIT_FAIL, `output collision: ${rel} exists and is not a Slim-owned module for ${pkgName}`);
}

/** Refuse symlink hops and unowned generated-output paths before mutation. */
export function assertGeneratedOutputSafe(
  root: string,
  slicePath: string,
  generatedPaths: string[],
  pkgName: string,
): void {
  const seen = new Set<string>();
  for (const p of [slicePath, ...generatedPaths]) {
    const abs = resolve(p);
    if (seen.has(abs)) continue;
    seen.add(abs);
    assertSafeWrite(root, abs);
  }
  assertNoOutputCollision(root, slicePath, pkgName);
  const sliceRel = posixRel(root, slicePath);
  for (const p of generatedPaths) {
    const abs = resolve(p);
    if (abs === resolve(slicePath)) continue;
    if (!pathExists(abs)) continue;
    if (!ownsSlice(root, pkgName, sliceRel)) {
      throw new SlimExit(
        EXIT_FAIL,
        `output collision: ${posixRel(root, abs)} exists and is not a Slim-owned module for ${pkgName}`,
      );
    }
  }
}
