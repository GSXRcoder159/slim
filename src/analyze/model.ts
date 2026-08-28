import { realpathSync, existsSync } from "node:fs";
import { isAbsolute, relative, resolve, sep, dirname, join } from "node:path";
import type ts from "typescript";
import type { ImportKind, ImportSite, SourceLoc, UnknownSite } from "../envelope/types.ts";
import { resolvePackageFamily } from "./family.ts";

export interface Binding {
  local: string;
  imported: string; // "*" for namespace, "default" for default
  specifier: string;
  kind: ImportKind;
  loc: SourceLoc;
}

export interface ProgramCtx {
  program: ts.Program;
  checker: ts.TypeChecker;
  options: ts.CompilerOptions;
  host: ts.CompilerHost;
}

export interface LocalPending {
  loc: SourceLoc;
  consumerFile: string;
  resolvedFile: string;
  names: Array<{ local: string; imported: string }>;
  namespaceLocal?: string;
  defaultLocal?: string;
}

export interface PkgLink {
  file: string;
  specifier: string;
  names: Map<string, string> | "*";
}

export interface LocalHop {
  file: string;
  specifier: string;
}

export interface CollectExtra {
  localPending: LocalPending[];
  pkgLinks: PkgLink[];
  localHops: LocalHop[];
  programCtx: ProgramCtx | null;
  root: string;
  typeOnly: ImportSite[];
  unknowns: UnknownSite[];
  wanted: Set<string> | null;
}

export function scriptKind(ts: typeof import("typescript"), file: string): ts.ScriptKind {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs")) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

export function locOf(sf: ts.SourceFile, node: ts.Node, root: string): SourceLoc {
  const start = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  const end = sf.getLineAndCharacterOfPosition(node.getEnd());
  return {
    file: toProjectRel(sf.fileName, root),
    line: start.line + 1,
    column: start.character + 1,
    endLine: end.line + 1,
    endColumn: end.character + 1,
  };
}

export function uid(prefix: string, sf: ts.SourceFile, node: ts.Node, root: string): string {
  return `${prefix}:${toProjectRel(sf.fileName, root)}:${node.getStart(sf)}`;
}

export function toProjectRel(file: string, root: string): string {
  const posix = (p: string) => p.split(sep).join("/");
  const relOf = (from: string, to: string): string | null => {
    const rel = relative(from, to);
    if (rel.startsWith("..") || isAbsolute(rel)) return null;
    return posix(rel);
  };
  const absFile = isAbsolute(file) ? file : resolve(root, file);
  const absRoot = resolve(root);
  let hit = relOf(absRoot, absFile);
  if (hit) return hit;
  try {
    hit = relOf(realpathSync(absRoot), realpathSync(absFile));
    if (hit) return hit;
  } catch {
    /* ignore */
  }
  const rootPosix = posix(absRoot).replace(/\/$/, "");
  const filePosix = posix(absFile);
  if (filePosix.startsWith(rootPosix + "/")) return filePosix.slice(rootPosix.length + 1);
  return posix(absFile);
}

export function normPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

export function exportNameOf(b: Binding): string {
  if (b.imported !== "*" && b.imported !== "default") return b.imported;
  const fam = resolvePackageFamily(b.specifier);
  if (fam?.subpath) return fam.subpath.split("/")[0]!;
  return b.imported === "default" ? "default" : "*";
}

export function resolveRelative(fromFile: string, spec: string): string | null {
  const dir = dirname(fromFile);
  const base = join(dir, spec);
  const candidates = [
    base,
    base + ".ts",
    base + ".js",
    base + ".tsx",
    base + ".mjs",
    base + ".cjs",
    join(base, "index.ts"),
    join(base, "index.js"),
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
}
