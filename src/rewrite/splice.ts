import { readFileSync, writeFileSync } from "node:fs";
import type ts from "typescript";
import { resolvePackageFamily } from "../analyze/family.ts";
import { loadTargetTypescript } from "../project.ts";

export interface SpliceEdit {
  start: number;
  end: number;
  text: string;
}

/** Position splice. Untouched bytes stay identical. */
export function applySplices(source: string, edits: SpliceEdit[]): string {
  const ordered = [...edits].sort((a, b) => b.start - a.start);
  let out = source;
  for (const e of ordered) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out;
}

/** Named catalog export for a per-method specifier (`lodash/get`, `lodash.get`). */
export function methodExportName(specifier: string): string | null {
  const fam = resolvePackageFamily(specifier);
  if (!fam?.subpath) return null;
  const last = fam.subpath.split("/").pop() ?? "";
  return last || null;
}

export function rewriteSpecifiers(
  ts: typeof import("typescript"),
  source: string,
  fileName: string,
  fromSpecifiers: Set<string>,
  toSpecifier: string,
): { text: string; changed: boolean } {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const edits: SpliceEdit[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const spec = node.moduleSpecifier.text;
      if (fromSpecifiers.has(spec)) {
        const typeOnlyDecl =
          (ts.isImportDeclaration(node) && Boolean(node.importClause?.isTypeOnly)) ||
          (ts.isExportDeclaration(node) && Boolean(node.isTypeOnly));
        if (typeOnlyDecl) return;
        edits.push({
          start: node.moduleSpecifier.getStart(sf),
          end: node.moduleSpecifier.getEnd(),
          text: JSON.stringify(toSpecifier),
        });
        if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
          rewriteDefaultPerMethodClause(ts, sf, node, spec, edits);
        }
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0]) &&
      fromSpecifiers.has(node.arguments[0].text)
    ) {
      edits.push({
        start: node.arguments[0].getStart(sf),
        end: node.arguments[0].getEnd(),
        text: JSON.stringify(toSpecifier),
      });
      const method = methodExportName(node.arguments[0].text);
      const parent = node.parent;
      if (
        method &&
        parent &&
        ts.isVariableDeclaration(parent) &&
        ts.isIdentifier(parent.name) &&
        parent.initializer === node
      ) {
        edits.push({ start: node.getEnd(), end: node.getEnd(), text: `.${method}` });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (!edits.length) return { text: source, changed: false };
  return { text: applySplices(source, edits), changed: true };
}

function rewriteDefaultPerMethodClause(
  ts: typeof import("typescript"),
  sf: ts.SourceFile,
  node: ts.ImportDeclaration,
  spec: string,
  edits: SpliceEdit[],
): void {
  const method = methodExportName(spec);
  const clause = node.importClause;
  if (!method || !clause?.name || clause.namedBindings || clause.isTypeOnly) return;
  const local = clause.name.text;
  const named = local === method ? `{ ${method} }` : `{ ${method} as ${local} }`;
  edits.push({ start: clause.getStart(sf), end: clause.getEnd(), text: named });
}

export function rewriteProjectImports(
  projectRoot: string,
  files: string[],
  fromSpecifiers: Set<string>,
  toSpecifier: string,
): string[] {
  const ts = loadTargetTypescript(projectRoot);
  const changed: string[] = [];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    const next = rewriteSpecifiers(ts, src, file, fromSpecifiers, toSpecifier);
    if (next.changed) {
      writeFileSync(file, next.text);
      changed.push(file);
    }
  }
  return changed;
}
