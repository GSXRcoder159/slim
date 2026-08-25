import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
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

/** Resolve target and require it to stay inside root (symlink-aware). */
export function assertInsideRoot(root: string, target: string): string {
  const absRoot = resolve(root);
  const absTarget = resolve(absRoot, target);
  const rootReal = realpathSync(existingAncestor(absRoot));
  const targetReal = realpathSync(existingAncestor(absTarget));
  const rel = relative(rootReal, targetReal);
  if (rel.startsWith("..") || rel === "..") {
    throw new SlimExit(EXIT_USAGE, `--out must stay inside the project root (got ${target})`);
  }
  if (absTarget === absRoot || absTarget.startsWith(absRoot + sep)) {
    return absTarget;
  }
  const relFromRoot = relative(absRoot, absTarget);
  if (relFromRoot.startsWith("..")) {
    throw new SlimExit(EXIT_USAGE, `--out must stay inside the project root (got ${target})`);
  }
  return absTarget;
}

/** False when the path is a symlink whose realpath escapes the project. */
export function isSafeToRewrite(root: string, file: string): boolean {
  try {
    const abs = resolve(file);
    if (!existsSync(abs)) return false;
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) {
      const real = realpathSync(abs);
      const rootReal = realpathSync(resolve(root));
      const rel = relative(rootReal, real);
      if (rel.startsWith("..")) return false;
    }
    const relFile = relative(resolve(root), abs);
    if (relFile.startsWith("..")) return false;
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
