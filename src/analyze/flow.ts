import type ts from "typescript";
import type { UnknownSite } from "../envelope/types.ts";
import type { Binding, CollectExtra } from "./model.ts";
import { locOf, normPath, toProjectRel, uid } from "./model.ts";
import { parseSpecifier } from "./family.ts";
import { unwrapExpr } from "./callee.ts";

const DYN_NAMES = new Set(["eval", "Function"]);
const GLOBAL_OBJS = new Set(["globalThis", "window", "global", "self"]);

export function unwrapDeep(ts: typeof import("typescript"), expr: ts.Expression): ts.Expression {
  let cur = unwrapExpr(ts, expr);
  while (ts.isBinaryExpression(cur) && cur.operatorToken.kind === ts.SyntaxKind.CommaToken) {
    cur = unwrapExpr(ts, cur.right);
  }
  return cur;
}

export function isDynamicCodeCallee(
  ts: typeof import("typescript"),
  expr: ts.Expression,
  aliases: Map<string, "eval" | "Function">,
): "eval" | "Function" | null {
  const cur = unwrapDeep(ts, expr);
  if (ts.isIdentifier(cur)) {
    if (cur.text === "eval" || cur.text === "Function") return cur.text;
    return aliases.get(cur.text) ?? null;
  }
  if (ts.isPropertyAccessExpression(cur) && ts.isIdentifier(cur.name)) {
    if (!DYN_NAMES.has(cur.name.text) || !isGlobalObj(ts, cur.expression)) return null;
    return cur.name.text === "Function" ? "Function" : "eval";
  }
  if (ts.isElementAccessExpression(cur)) {
    const arg = cur.argumentExpression ? unwrapDeep(ts, cur.argumentExpression) : undefined;
    if (!arg || !ts.isStringLiteral(arg) || !DYN_NAMES.has(arg.text)) return null;
    if (!isGlobalObj(ts, cur.expression)) return null;
    return arg.text === "Function" ? "Function" : "eval";
  }
  return null;
}

export function bindingFromExpr(
  ts: typeof import("typescript"),
  expr: ts.Expression,
  localSet: Map<string, Binding>,
): Binding | null {
  expr = unwrapDeep(ts, expr);
  if (ts.isIdentifier(expr) && localSet.has(expr.text)) return localSet.get(expr.text)!;
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) {
    const obj = unwrapDeep(ts, expr.expression);
    if (ts.isIdentifier(obj) && localSet.has(obj.text)) {
      const b = localSet.get(obj.text)!;
      if (b.imported === "*" || b.imported === "default") {
        return { ...b, local: expr.name.text, imported: expr.name.text, kind: "named" };
      }
    }
  }
  return null;
}

export function bindPatternOrIdent(
  ts: typeof import("typescript"),
  name: ts.BindingName,
  initializer: ts.Expression | undefined,
  localSet: Map<string, Binding>,
  bindings: Binding[] | null,
): void {
  if (!initializer) return;
  if (ts.isIdentifier(name)) {
    const b = bindingFromExpr(ts, initializer, localSet);
    if (b) {
      const next = { ...b, local: name.text };
      localSet.set(name.text, next);
      bindings?.push(next);
    }
    return;
  }
  if (!ts.isObjectBindingPattern(name)) return;
  const ns = bindingFromExpr(ts, initializer, localSet);
  if (!ns || (ns.imported !== "*" && ns.imported !== "default")) return;
  for (const el of name.elements) {
    if (!ts.isIdentifier(el.name)) continue;
    const imported =
      el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : el.name.text;
    const next: Binding = { ...ns, local: el.name.text, imported, kind: "named" };
    localSet.set(el.name.text, next);
    bindings?.push(next);
  }
}

/** File-level aliases and `export { local }` hops, before bindLocalReexports. */
export function collectFileAliases(
  ts: typeof import("typescript"),
  sf: ts.SourceFile,
  bindings: Binding[],
  extra: CollectExtra,
): void {
  const nf = toProjectRel(sf.fileName, extra.root);
  const localSet = new Map(bindings.filter((b) => b.loc.file === nf).map((b) => [b.local, b]));
  for (const stmt of sf.statements) {
    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        bindPatternOrIdent(ts, d.name, d.initializer, localSet, bindings);
      }
    }
    if (
      ts.isExpressionStatement(stmt) &&
      ts.isBinaryExpression(stmt.expression) &&
      stmt.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(stmt.expression.left)
    ) {
      bindPatternOrIdent(ts, stmt.expression.left, stmt.expression.right, localSet, bindings);
    }
    if (
      ts.isExportDeclaration(stmt) &&
      !stmt.moduleSpecifier &&
      stmt.exportClause &&
      ts.isNamedExports(stmt.exportClause)
    ) {
      for (const el of stmt.exportClause.elements) {
        if (el.isTypeOnly) continue;
        const localName = (el.propertyName ?? el.name).text;
        const exported = el.name.text;
        const b = localSet.get(localName);
        if (!b || !parseSpecifier(b.specifier)) continue;
        extra.pkgLinks.push({
          file: normPath(sf.fileName),
          specifier: b.specifier,
          names: new Map([[exported, b.imported === "*" ? exported : b.imported]]),
        });
      }
    }
    if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
      const b = bindingFromExpr(ts, stmt.expression, localSet);
      if (!b || !parseSpecifier(b.specifier)) continue;
      extra.pkgLinks.push({
        file: normPath(sf.fileName),
        specifier: b.specifier,
        names: new Map([["default", b.imported === "*" ? "default" : b.imported]]),
      });
    }
  }
}

export function pushUnknown(
  ts: typeof import("typescript"),
  sf: ts.SourceFile,
  node: ts.Node,
  extra: CollectExtra,
  unknowns: UnknownSite[],
  kind: UnknownSite["kind"],
  detail: string,
  widensTo: UnknownSite["widensTo"],
  prefix: string,
): void {
  unknowns.push({
    id: uid(prefix, sf, node, extra.root),
    loc: locOf(sf, node, extra.root),
    kind,
    detail,
    widensTo,
    traceObservedMembers: null,
  });
}

export function identifierValueEscape(
  ts: typeof import("typescript"),
  ident: ts.Identifier,
  localSet: Map<string, Binding>,
): Binding | null {
  if (!localSet.has(ident.text)) return null;
  if (isAccountedIdentifier(ts, ident)) return null;
  return localSet.get(ident.text)!;
}

function isGlobalObj(ts: typeof import("typescript"), expr: ts.Expression): boolean {
  const obj = unwrapDeep(ts, expr);
  if (obj.kind === ts.SyntaxKind.ThisKeyword) return true;
  return ts.isIdentifier(obj) && GLOBAL_OBJS.has(obj.text);
}

function isAccountedIdentifier(ts: typeof import("typescript"), ident: ts.Identifier): boolean {
  if (isTypeish(ts, ident)) return true;
  const p = ident.parent;
  if (!p) return true;
  if (ts.isTypeQueryNode(p) || ts.isTypeNode(p)) return true;
  if (ts.isExpressionWithTypeArguments(p)) return true;
  if (ts.isQualifiedName(p)) return true;
  if (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p)) return true;
  if (ts.isExportSpecifier(p) || ts.isNamespaceExport(p)) return true;
  if (ts.isBindingElement(p) || ts.isParameter(p)) return true;
  if (ts.isVariableDeclaration(p) && p.name === ident) return true;
  if (ts.isPropertyAssignment(p) && p.name === ident) return true;
  if ((ts.isMethodDeclaration(p) || ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)) && p.name === ident) {
    return true;
  }
  if (ts.isPropertyAccessExpression(p) && (p.name === ident || unwrapDeep(ts, p.expression) === ident)) {
    return true;
  }
  if (ts.isElementAccessExpression(p) && unwrapDeep(ts, p.expression) === ident) return true;
  if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && unwrapDeep(ts, p.expression) === ident) {
    return true;
  }
  if (ts.isTaggedTemplateExpression(p) && unwrapDeep(ts, p.tag) === ident) return true;
  if (ts.isVariableDeclaration(p) && p.initializer && identInExpr(ts, p.initializer, ident)) {
    if (ts.isIdentifier(p.name) || ts.isObjectBindingPattern(p.name)) return true;
  }
  if (
    ts.isBinaryExpression(p) &&
    p.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    identInExpr(ts, p.right, ident) &&
    ts.isIdentifier(p.left)
  ) {
    return true;
  }
  return false;
}

function identInExpr(
  ts: typeof import("typescript"),
  expr: ts.Expression,
  ident: ts.Identifier,
): boolean {
  const cur = unwrapDeep(ts, expr);
  return cur === ident;
}

function isTypeish(ts: typeof import("typescript"), ident: ts.Identifier): boolean {
  for (let p: ts.Node | undefined = ident.parent; p; p = p.parent) {
    if (
      ts.isTypeNode(p) ||
      ts.isTypeQueryNode(p) ||
      ts.isQualifiedName(p) ||
      ts.isTypeReferenceNode(p) ||
      ts.isExpressionWithTypeArguments(p) ||
      ts.isImportTypeNode(p) ||
      ts.isTypeAliasDeclaration(p) ||
      ts.isInterfaceDeclaration(p) ||
      ts.isTypeParameterDeclaration(p) ||
      ts.isHeritageClause(p)
    ) {
      return true;
    }
    if (ts.isSourceFile(p)) break;
  }
  return false;
}
