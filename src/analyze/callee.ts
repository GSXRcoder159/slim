import type ts from "typescript";
import type { ThisBinding } from "../envelope/types.ts";
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
): { exportName: string; memberPath: string[]; dynamic: boolean } | null {
  expr = unwrapExpr(ts, expr);
  if (isRequireOfWanted(ts, expr, wanted)) {
    return { exportName: "*", memberPath: [], dynamic: false };
  }
  if (ts.isIdentifier(expr) && localSet.has(expr.text)) {
    const b = localSet.get(expr.text)!;
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
    if (ts.isIdentifier(obj) && localSet.has(obj.text)) {
      const b = localSet.get(obj.text)!;
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
    const inner = resolveCallee(ts, expr.expression, localSet, wanted);
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
    if (ts.isIdentifier(obj) && localSet.has(obj.text)) {
      const arg = expr.argumentExpression;
      if (arg && ts.isStringLiteral(unwrapExpr(ts, arg))) {
        const lit = unwrapExpr(ts, arg) as ts.StringLiteral;
        return { exportName: lit.text, memberPath: [lit.text], dynamic: false };
      }
      return { exportName: "*", memberPath: [], dynamic: true };
    }
    const inner = resolveCallee(ts, expr.expression, localSet, wanted);
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
      const inner = resolveCallee(ts, expr.expression.expression, localSet, wanted);
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
): { callee: ts.Expression; thisKind: ThisBinding | null } {
  expr = unwrapExpr(ts, expr);
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) {
    const n = expr.name.text;
    if (n === "call" || n === "apply" || n === "bind") {
      const inner = resolveCallee(ts, expr.expression, localSet, wanted);
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
): { name: string; namespace: boolean } | null {
  if (ts.isSpreadElement(arg)) return asBindingEscape(ts, arg.expression, localSet);
  arg = unwrapExpr(ts, arg);
  if (ts.isIdentifier(arg) && localSet.has(arg.text)) {
    const b = localSet.get(arg.text)!;
    return {
      name: b.imported === "default" ? b.local : b.imported,
      namespace: b.imported === "*",
    };
  }
  if (ts.isPropertyAccessExpression(arg) && ts.isIdentifier(arg.name)) {
    if (ts.isIdentifier(arg.expression) && localSet.has(arg.expression.text)) {
      return { name: arg.name.text, namespace: false };
    }
  }
  return null;
}

export function namespaceIdent(
  ts: typeof import("typescript"),
  expr: ts.Expression,
  localSet: Map<string, Binding>,
): Binding | null {
  const id = unwrapExpr(ts, expr);
  if (!ts.isIdentifier(id) || !localSet.has(id.text)) return null;
  const b = localSet.get(id.text)!;
  return b.imported === "*" ? b : null;
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
