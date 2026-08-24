import type ts from "typescript";
import type { ArgShape, CallSite } from "../envelope/types.ts";
import { emptyHyrum } from "../envelope/types.ts";

export function shapeOf(
  ts: typeof import("typescript"),
  node: ts.Expression,
  checker?: ts.TypeChecker,
): ArgShape {
  if (ts.isSpreadElement(node)) return { kind: "unknown" };
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return { kind: "literal", literals: [node.text] };
  }
  if (ts.isNumericLiteral(node)) return { kind: "literal", literals: [Number(node.text)] };
  if (node.kind === ts.SyntaxKind.TrueKeyword) return { kind: "literal", literals: [true] };
  if (node.kind === ts.SyntaxKind.FalseKeyword) return { kind: "literal", literals: [false] };
  if (node.kind === ts.SyntaxKind.NullKeyword) return { kind: "literal", literals: [null] };
  if (node.kind === ts.SyntaxKind.UndefinedKeyword) return { kind: "literal", literals: [undefined] };
  if (ts.isArrayLiteralExpression(node)) {
    return {
      kind: "array",
      elements: node.elements.map((el) => {
        if (ts.isOmittedExpression(el) || ts.isSpreadElement(el)) return { kind: "unknown" as const };
        return shapeOf(ts, el, checker);
      }),
    };
  }
  if (ts.isObjectLiteralExpression(node)) {
    const props: Record<string, ArgShape> = {};
    for (const p of node.properties) {
      if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) {
        props[p.name.text] = shapeOf(ts, p.initializer as ts.Expression, checker);
      } else if (ts.isPropertyAssignment(p) && ts.isStringLiteral(p.name)) {
        props[p.name.text] = shapeOf(ts, p.initializer as ts.Expression, checker);
      }
    }
    return { kind: "object", props };
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    return { kind: "function", fnArity: node.parameters.length };
  }
  if (checker) {
    const lits = typeLiterals(ts, checker.getTypeAtLocation(node));
    if (lits.length === 1) return { kind: "literal", literals: lits };
    if (lits.length > 1) return { kind: "union", literals: lits };
  }
  return { kind: "any" };
}

export function inferHyrum(exportName: string, sites: CallSite[]) {
  const h = emptyHyrum();
  if (exportName === "get" || exportName === "set" || exportName === "has") {
    h.prototype = true;
    h.sameReference = exportName === "get";
  }
  if (exportName === "debounce" || exportName === "throttle") {
    h.errorMessage = true;
  }
  if (sites.some((s) => s.argShapes.some((a) => a.kind === "array"))) {
    h.sparseArray = true;
  }
  return h;
}

function identHasExplicitAny(ts: typeof import("typescript"), ident: ts.Identifier): boolean {
  let scope: ts.Node | undefined = ident.parent;
  while (scope) {
    const params = functionParams(ts, scope);
    if (params) {
      for (const p of params) {
        if (ts.isIdentifier(p.name) && p.name.text === ident.text) {
          return p.type?.kind === ts.SyntaxKind.AnyKeyword;
        }
      }
    }
    const vd = varDeclInScope(ts, scope, ident.text);
    if (vd) return vd.type?.kind === ts.SyntaxKind.AnyKeyword;
    scope = scope.parent;
  }
  return false;
}

export function argIsTsAny(
  ts: typeof import("typescript"),
  node: ts.Expression,
  checker?: ts.TypeChecker,
): boolean {
  if (ts.isSpreadElement(node)) return argIsTsAny(ts, node.expression, checker);
  node = unwrapParens(ts, node);
  if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
    if (node.type.kind === ts.SyntaxKind.AnyKeyword) return true;
    return argIsTsAny(ts, node.expression, checker);
  }
  if (ts.isIdentifier(node) && identHasExplicitAny(ts, node)) return true;
  if (checker) {
    const type = checker.getTypeAtLocation(node);
    if (type.flags & ts.TypeFlags.Any) return true;
  }
  return false;
}

function typeLiterals(ts: typeof import("typescript"), type: ts.Type): unknown[] {
  if (type.isUnion()) return type.types.flatMap((t) => typeLiterals(ts, t));
  if (type.isStringLiteral()) return [type.value];
  if (type.isNumberLiteral()) return [type.value];
  if (type.flags & ts.TypeFlags.BooleanLiteral) {
    return [(type as { intrinsicName?: string }).intrinsicName === "true"];
  }
  if (type.flags & ts.TypeFlags.Null) return [null];
  if (type.flags & ts.TypeFlags.Undefined) return [undefined];
  return [];
}

function unwrapParens(ts: typeof import("typescript"), node: ts.Expression): ts.Expression {
  let cur = node;
  while (ts.isParenthesizedExpression(cur)) cur = cur.expression;
  return cur;
}

function functionParams(
  ts: typeof import("typescript"),
  node: ts.Node,
): readonly ts.ParameterDeclaration[] | undefined {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    return node.parameters;
  }
  return undefined;
}

function varDeclInScope(
  ts: typeof import("typescript"),
  scope: ts.Node,
  name: string,
): ts.VariableDeclaration | undefined {
  const stmts = ts.isBlock(scope) || ts.isModuleBlock(scope) || ts.isSourceFile(scope)
    ? scope.statements
    : undefined;
  if (!stmts) return undefined;
  for (const s of stmts) {
    if (!ts.isVariableStatement(s)) continue;
    for (const d of s.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.name.text === name) return d;
    }
  }
  return undefined;
}
