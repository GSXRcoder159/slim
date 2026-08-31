import type ts from "typescript";
import type { ThisBinding, CallSite } from "../envelope/types.ts";
import type { Binding } from "./model.ts";
import { exportNameOf } from "./model.ts";
import { specifierMatches } from "./reexports.ts";

export function unwrapExpr(ts: typeof import("typescript"), expr: ts.Expression): ts.Expression {
  let cur: ts.Expression = expr;
  for (;;) {
    if (ts.isParenthesizedExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    if (ts.isAsExpression(cur) || ts.isTypeAssertionExpression(cur) || ts.isSatisfiesExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    if (ts.isNonNullExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    if (ts.isBinaryExpression(cur) && cur.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      cur = cur.right;
      continue;
    }
    return cur;
  }
}

export function resolveCallee(
  ts: typeof import("typescript"),
  expr: ts.Expression,
  localSet: Map<string, Binding>,
  wanted: Set<string> | null,
  checker?: ts.TypeChecker,
): { exportName: string; memberPath: string[]; dynamic: boolean } | null {
  expr = unwrapExpr(ts, expr);
  if (isRequireOfWanted(ts, expr, wanted)) {
    return { exportName: "*", memberPath: [], dynamic: false };
  }
  if (ts.isIdentifier(expr)) {
    const b = bindingForReference(ts, expr, localSet, checker);
    if (!b) return null;
    const exportName = exportNameOf(b);
    if (exportName === "*") {
      return { exportName: "*", memberPath: [], dynamic: false };
    }
    return {
      exportName,
      memberPath: exportName === "default" ? [] : [exportName],
      dynamic: false,
    };
  }
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) {
    const obj = unwrapExpr(ts, expr.expression);
    if (ts.isIdentifier(obj)) {
      const b = bindingForReference(ts, obj, localSet, checker);
      if (!b) return null;
      if (b.imported === "*" || b.imported === "default") {
        return {
          exportName: expr.name.text,
          memberPath: [expr.name.text],
          dynamic: false,
        };
      }
      return {
        exportName: b.imported,
        memberPath: [b.imported, expr.name.text],
        dynamic: false,
      };
    }
    const inner = resolveCallee(ts, expr.expression, localSet, wanted, checker);
    if (inner) {
      if (inner.exportName === "*" && inner.memberPath.length === 0) {
        return {
          exportName: expr.name.text,
          memberPath: [expr.name.text],
          dynamic: inner.dynamic,
        };
      }
      return {
        exportName: inner.exportName,
        memberPath: [...inner.memberPath, expr.name.text],
        dynamic: inner.dynamic,
      };
    }
  }
  if (ts.isElementAccessExpression(expr)) {
    const obj = unwrapExpr(ts, expr.expression);
    if (ts.isIdentifier(obj) && bindingForReference(ts, obj, localSet, checker)) {
      const arg = expr.argumentExpression;
      if (arg && ts.isStringLiteral(unwrapExpr(ts, arg))) {
        const lit = unwrapExpr(ts, arg) as ts.StringLiteral;
        return { exportName: lit.text, memberPath: [lit.text], dynamic: false };
      }
      return { exportName: "*", memberPath: [], dynamic: true };
    }
    const inner = resolveCallee(ts, expr.expression, localSet, wanted, checker);
    if (inner) {
      const arg = expr.argumentExpression;
      if (arg && ts.isStringLiteral(unwrapExpr(ts, arg))) {
        const lit = unwrapExpr(ts, arg) as ts.StringLiteral;
        if (inner.exportName === "*" && inner.memberPath.length === 0) {
          return { exportName: lit.text, memberPath: [lit.text], dynamic: inner.dynamic };
        }
        return {
          exportName: lit.text,
          memberPath: [...inner.memberPath, lit.text],
          dynamic: inner.dynamic,
        };
      }
      return { ...inner, dynamic: true };
    }
  }
  if (ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression)) {
    const name = expr.expression.name;
    if (ts.isIdentifier(name) && (name.text === "bind" || name.text === "call" || name.text === "apply")) {
      const inner = resolveCallee(ts, expr.expression.expression, localSet, wanted, checker);
      if (inner) return { ...inner, dynamic: true };
    }
  }
  return null;
}

export function peelCallApplyBind(
  ts: typeof import("typescript"),
  expr: ts.Expression,
  localSet: Map<string, Binding>,
  wanted: Set<string> | null,
  checker?: ts.TypeChecker,
): { callee: ts.Expression; thisKind: ThisBinding | null } {
  expr = unwrapExpr(ts, expr);
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) {
    const n = expr.name.text;
    if (n === "call" || n === "apply" || n === "bind") {
      const inner = resolveCallee(ts, expr.expression, localSet, wanted, checker);
      if (inner && !inner.dynamic && !(inner.exportName === "*" && inner.memberPath.length === 0)) {
        return { callee: expr.expression, thisKind: { kind: n } };
      }
    }
  }
  return { callee: expr, thisKind: null };
}

export function thisOf(ts: typeof import("typescript"), expr: ts.Expression): ThisBinding {
  expr = unwrapExpr(ts, expr);
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) {
    const n = expr.name.text;
    if (n === "call" || n === "apply" || n === "bind") return { kind: n };
    return { kind: "method" };
  }
  if (ts.isElementAccessExpression(expr)) return { kind: "method" };
  if (ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression)) {
    const n = expr.expression.name;
    if (ts.isIdentifier(n) && n.text === "call") return { kind: "call" };
    if (ts.isIdentifier(n) && n.text === "apply") return { kind: "apply" };
    if (ts.isIdentifier(n) && n.text === "bind") return { kind: "bind" };
  }
  return { kind: "unbound" };
}

export function asBindingEscape(
  ts: typeof import("typescript"),
  arg: ts.Expression,
  localSet: Map<string, Binding>,
  checker?: ts.TypeChecker,
): { name: string; namespace: boolean } | null {
  if (ts.isSpreadElement(arg)) return asBindingEscape(ts, arg.expression, localSet, checker);
  arg = unwrapExpr(ts, arg);
  if (ts.isIdentifier(arg)) {
    const b = bindingForReference(ts, arg, localSet, checker);
    if (!b) return null;
    return {
      name: b.imported === "default" ? b.local : b.imported,
      namespace: b.imported === "*",
    };
  }
  if (ts.isPropertyAccessExpression(arg) && ts.isIdentifier(arg.name)) {
    if (ts.isIdentifier(arg.expression) && bindingForReference(ts, arg.expression, localSet, checker)) {
      return { name: arg.name.text, namespace: false };
    }
  }
  return null;
}

export function namespaceIdent(
  ts: typeof import("typescript"),
  expr: ts.Expression,
  localSet: Map<string, Binding>,
  checker?: ts.TypeChecker,
): Binding | null {
  const id = unwrapExpr(ts, expr);
  if (!ts.isIdentifier(id)) return null;
  const b = bindingForReference(ts, id, localSet, checker);
  if (!b) return null;
  return b.imported === "*" ? b : null;
}

/** Resolve the checker binding before trusting a same-named package import. */
function bindingForReference(
  ts: typeof import("typescript"),
  ident: ts.Identifier,
  localSet: Map<string, Binding>,
  checker?: ts.TypeChecker,
): Binding | null {
  const binding = localSet.get(ident.text);
  if (!binding) return null;
  if (!checker) return lexicallyShadowed(ts, ident, localSet) ? null : binding;
  const symbol = checker.getSymbolAtLocation(ident);
  if (!symbol || !symbolReferencesPackage(ts, symbol, checker, localSet, new Set())) return null;
  return binding;
}

function symbolReferencesPackage(
  ts: typeof import("typescript"),
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  localSet: Map<string, Binding>,
  seen: Set<ts.Symbol>,
): boolean {
  if (seen.has(symbol)) return false;
  seen.add(symbol);
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    return symbol.declarations?.some((d) => ts.isImportSpecifier(d) || ts.isImportClause(d) || ts.isNamespaceImport(d)) ?? false;
  }
  for (const declaration of symbol.declarations ?? []) {
    if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
      if (expressionReferencesPackage(ts, declaration.initializer, checker, localSet, seen)) return true;
    }
    if (ts.isBindingElement(declaration)) {
      const pattern = declaration.parent;
      const variable = pattern.parent;
      if (ts.isVariableDeclaration(variable) && variable.initializer &&
        expressionReferencesPackage(ts, variable.initializer, checker, localSet, seen)) return true;
    }
  }
  return false;
}

function expressionReferencesPackage(
  ts: typeof import("typescript"),
  expr: ts.Expression,
  checker: ts.TypeChecker,
  localSet: Map<string, Binding>,
  seen: Set<ts.Symbol>,
): boolean {
  let cur = unwrapExpr(ts, expr);
  if (ts.isAwaitExpression(cur)) cur = unwrapExpr(ts, cur.expression);
  if (ts.isIdentifier(cur)) {
    const source = checker.getSymbolAtLocation(cur);
    return Boolean(source && localSet.has(cur.text) && symbolReferencesPackage(ts, source, checker, localSet, seen));
  }
  if (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) {
    return expressionReferencesPackage(ts, cur.expression, checker, localSet, seen);
  }
  return isPackageLoaderCall(ts, cur);
}

function lexicallyShadowed(
  ts: typeof import("typescript"),
  ident: ts.Identifier,
  localSet: Map<string, Binding>,
): boolean {
  const name = ident.text;
  const names = (n: ts.BindingName): boolean =>
    ts.isIdentifier(n) ? n.text === name : n.elements.some((e) => !ts.isOmittedExpression(e) && names(e.name));
  const statements = (scope: ts.Node & { statements?: ts.NodeArray<ts.Statement> }): boolean => {
    for (const stmt of scope.statements ?? []) {
      if (ts.isImportDeclaration(stmt)) continue;
      if ((ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) && stmt.name?.text === name) return true;
      if (ts.isVariableStatement(stmt) && stmt.declarationList.declarations.some((d) =>
        names(d.name) && !packageDeclaration(ts, d, localSet, name))) return true;
    }
    return false;
  };
  for (let p: ts.Node | undefined = ident.parent; p; p = p.parent) {
    if (ts.isFunctionLike(p)) {
      if (p.parameters.some((param) => names(param.name))) return true;
      if (ts.isFunctionDeclaration(p) && p.name?.text === name) return true;
    }
    if (ts.isCatchClause(p) && p.variableDeclaration && names(p.variableDeclaration.name)) return true;
    if (ts.isBlock(p) || ts.isModuleBlock(p) || ts.isSourceFile(p) || ts.isCaseBlock(p)) {
      if (statements(p)) return true;
    }
    if ((ts.isForStatement(p) || ts.isForInStatement(p) || ts.isForOfStatement(p)) &&
      p.initializer && ts.isVariableDeclarationList(p.initializer) &&
      p.initializer.declarations.some((d) => names(d.name))) return true;
  }
  return false;
}

function packageDeclaration(
  ts: typeof import("typescript"),
  declaration: ts.VariableDeclaration,
  localSet: Map<string, Binding>,
  name: string,
): boolean {
  if (!declaration.initializer || !localSet.has(name)) return false;
  let init = unwrapExpr(ts, declaration.initializer);
  if (ts.isAwaitExpression(init)) init = unwrapExpr(ts, init.expression);
  if (ts.isIdentifier(init) && localSet.has(init.text)) return true;
  if ((ts.isPropertyAccessExpression(init) || ts.isElementAccessExpression(init)) &&
    ts.isIdentifier(unwrapExpr(ts, init.expression)) &&
    localSet.has((unwrapExpr(ts, init.expression) as ts.Identifier).text)) return true;
  return isPackageLoaderCall(ts, init);
}

function isPackageLoaderCall(ts: typeof import("typescript"), expr: ts.Expression): boolean {
  return ts.isCallExpression(expr) &&
    ((ts.isIdentifier(expr.expression) && expr.expression.text === "require") ||
      expr.expression.kind === ts.SyntaxKind.ImportKeyword);
}

function isRequireOfWanted(
  ts: typeof import("typescript"),
  expr: ts.Expression,
  wanted: Set<string> | null,
): boolean {
  if (!ts.isCallExpression(expr)) return false;
  const cal = unwrapExpr(ts, expr.expression);
  if (!ts.isIdentifier(cal) || cal.text !== "require") return false;
  const arg = expr.arguments[0];
  if (!arg) return false;
  if (!ts.isStringLiteral(arg) && !ts.isNoSubstitutionTemplateLiteral(arg)) return false;
  return specifierMatches(arg.text, wanted);
}

export function originCallSite(
  ts: typeof import("typescript"),
  expr: ts.Expression,
  lookupIdent: (name: string) => CallSite | undefined,
  callByNode: WeakMap<ts.Node, CallSite>,
): CallSite | undefined {
  const u = unwrapExpr(ts, expr);
  if (ts.isIdentifier(u)) return lookupIdent(u.text);
  if (ts.isCallExpression(u)) {
    return callByNode.get(u) ?? originCallSite(ts, u.expression, lookupIdent, callByNode);
  }
  if (ts.isPropertyAccessExpression(u)) return originCallSite(ts, u.expression, lookupIdent, callByNode);
  if (ts.isElementAccessExpression(u)) return originCallSite(ts, u.expression, lookupIdent, callByNode);
  return undefined;
}
