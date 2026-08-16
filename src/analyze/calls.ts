import type ts from "typescript";
import type { CallSite, ThisBinding, UnknownSite } from "../envelope/types.ts";
import type { Binding, CollectExtra } from "./model.ts";
import { exportNameOf, locOf, toProjectRel, uid } from "./model.ts";
import { localFromImportCall, specifierMatches } from "./reexports.ts";
import { argIsTsAny, shapeOf } from "./shapes.ts";

export function walkUses(
  ts: typeof import("typescript"),
  sf: ts.SourceFile,
  bindings: Binding[],
  wanted: Set<string> | null,
  callSites: CallSite[],
  unknowns: UnknownSite[],
  resultMembers: Map<string, Set<string>>,
  extra: CollectExtra,
  checker?: ts.TypeChecker,
): void {
  const nf = toProjectRel(sf.fileName, extra.root);
  const bindByLocal = bindings.filter(
    (b) => b.loc.file === nf && specifierMatches(b.specifier, wanted),
  );
  const localSet = new Map(bindByLocal.map((b) => [b.local, b]));
  const resultScopes: Array<Map<string, CallSite>> = [new Map()];

  const lookupResult = (name: string): CallSite | undefined => {
    for (let i = resultScopes.length - 1; i >= 0; i--) {
      const hit = resultScopes[i]!.get(name);
      if (hit) return hit;
    }
    return undefined;
  };

  const visit = (node: ts.Node) => {
    const scoped = isBindingScope(ts, node);
    if (scoped) resultScopes.push(new Map());
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "eval") {
      unknowns.push({
        id: uid("eval", sf, node),
        loc: locOf(sf, node, extra.root),
        kind: "eval",
        detail: "eval()",
        widensTo: "refuse",
        traceObservedMembers: null,
      });
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Function") {
      unknowns.push({
        id: uid("fn", sf, node),
        loc: locOf(sf, node, extra.root),
        kind: "eval",
        detail: "new Function",
        widensTo: "refuse",
        traceObservedMembers: null,
      });
    }

    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      if (arg && !ts.isStringLiteral(arg) && !ts.isNoSubstitutionTemplateLiteral(arg)) {
        unknowns.push({
          id: uid("dynimp", sf, node),
          loc: locOf(sf, node, extra.root),
          kind: "dynamic-specifier",
          detail: "import(non-literal)",
          widensTo: "refuse",
          traceObservedMembers: null,
        });
      }
    }

    if (localSet.size && ts.isCallExpression(node)) {
      const info = resolveCallee(ts, node.expression, localSet);
      if (info) {
        if (info.dynamic) {
          unknowns.push({
            id: uid("dyn", sf, node),
            loc: locOf(sf, node, extra.root),
            kind: "dynamic-member",
            detail: `computed member on ${info.exportName}`,
            widensTo: "all-exports",
            traceObservedMembers: null,
          });
        } else {
          const spread = node.arguments.some((a) => ts.isSpreadElement(a));
          const argc = node.arguments.length;
          const argShapes = node.arguments.map((a) => {
            if (argIsTsAny(ts, a, checker)) return { kind: "unknown" as const };
            return shapeOf(ts, a, checker);
          });
          const thisBinding = thisOf(ts, node.expression);
          const site: CallSite = {
            id: uid("call", sf, node),
            loc: locOf(sf, node, extra.root),
            exportName: info.exportName,
            memberPath: info.memberPath,
            thisBinding,
            argc: {
              min: spread ? 0 : argc,
              max: spread ? null : argc,
              observed: [argc],
            },
            argShapes,
            spread,
            resultMembers: [],
          };
          callSites.push(site);
          const resultLocal = localFromImportCall(ts, node);
          if (resultLocal) resultScopes[resultScopes.length - 1]!.set(resultLocal, site);
          if (spread) {
            unknowns.push({
              id: uid("spread", sf, node),
              loc: locOf(sf, node, extra.root),
              kind: "spread-args",
              detail: `spread arguments on ${info.exportName}`,
              widensTo: "full-signature",
              traceObservedMembers: null,
            });
          }
          for (const a of node.arguments) {
            if (!argIsTsAny(ts, a, checker)) continue;
            unknowns.push({
              id: uid("any", sf, a),
              loc: locOf(sf, a, extra.root),
              kind: "ts-any",
              detail: `any-typed argument to ${info.exportName}`,
              widensTo: "full-signature",
              traceObservedMembers: null,
            });
          }
        }
      }
      for (const arg of node.arguments) {
        const escaped = asBindingEscape(ts, arg, localSet);
        if (escaped) {
          unknowns.push({
            id: uid("esc", sf, arg),
            loc: locOf(sf, arg, extra.root),
            kind: "binding-escape",
            detail: `${escaped} passed as callback (iteratee arity 3 assumed for get)`,
            widensTo: "full-signature",
            traceObservedMembers: null,
          });
          if (escaped === "get" || escaped.endsWith(".get")) {
            callSites.push({
              id: uid("mapget", sf, arg),
              loc: locOf(sf, arg, extra.root),
              exportName: "get",
              memberPath: ["get"],
              thisBinding: { kind: "unknown", reason: "iteratee" },
              argc: { min: 1, max: 3, observed: [3] },
              argShapes: [{ kind: "any" }, { kind: "any" }, { kind: "any" }],
              spread: false,
              resultMembers: [],
            });
          }
        }
      }
    }

    if (ts.isPropertyAccessExpression(node)) {
      const obj = unwrapExpr(ts, node.expression);
      const resultSite = ts.isIdentifier(obj) ? lookupResult(obj.text) : undefined;
      if (resultSite && ts.isIdentifier(node.name)) {
        const site = resultSite;
        const mem = node.name.text;
        if (!site.resultMembers.includes(mem)) site.resultMembers.push(mem);
        const set = resultMembers.get(site.exportName) ?? new Set();
        set.add(mem);
        resultMembers.set(site.exportName, set);
      }
      const info = resolveCallee(ts, node.expression, localSet);
      if (info && !info.dynamic && ts.isIdentifier(node.name)) {
        const parentCall = ts.isCallExpression(node.parent) && node.parent.expression === node;
        if (!parentCall) {
          const set = resultMembers.get(info.exportName) ?? new Set();
          set.add(node.name.text);
          resultMembers.set(info.exportName, set);
        }
      }
    }

    if (ts.isElementAccessExpression(node)) {
      const obj = unwrapExpr(ts, node.expression);
      if (ts.isIdentifier(obj) && localSet.has(obj.text)) {
        const arg = node.argumentExpression;
        if (arg && !ts.isStringLiteral(arg) && !ts.isNumericLiteral(arg)) {
          unknowns.push({
            id: uid("dynm", sf, node),
            loc: locOf(sf, node, extra.root),
            kind: "dynamic-member",
            detail: `computed access ${obj.text}[...]`,
            widensTo: "all-exports",
            traceObservedMembers: null,
          });
        }
      }
    }

    ts.forEachChild(node, visit);
    if (scoped) resultScopes.pop();
  };
  visit(sf);
}

function unwrapExpr(ts: typeof import("typescript"), expr: ts.Expression): ts.Expression {
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
    return cur;
  }
}

function resolveCallee(
  ts: typeof import("typescript"),
  expr: ts.Expression,
  localSet: Map<string, Binding>,
): { exportName: string; memberPath: string[]; dynamic: boolean } | null {
  expr = unwrapExpr(ts, expr);
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
    const inner = resolveCallee(ts, expr.expression, localSet);
    if (inner) {
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
    const inner = resolveCallee(ts, expr.expression, localSet);
    if (inner) {
      const arg = expr.argumentExpression;
      if (arg && ts.isStringLiteral(unwrapExpr(ts, arg))) {
        const lit = unwrapExpr(ts, arg) as ts.StringLiteral;
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
    // lodash.bind(obj, 'map') — treat as unknown
    const name = expr.expression.name;
    if (ts.isIdentifier(name) && (name.text === "bind" || name.text === "call" || name.text === "apply")) {
      const inner = resolveCallee(ts, expr.expression.expression, localSet);
      if (inner) {
        return { ...inner, dynamic: true };
      }
    }
  }
  return null;
}

function asBindingEscape(
  ts: typeof import("typescript"),
  arg: ts.Expression,
  localSet: Map<string, Binding>,
): string | null {
  if (ts.isSpreadElement(arg)) return asBindingEscape(ts, arg.expression, localSet);
  if (ts.isIdentifier(arg) && localSet.has(arg.text)) {
    const b = localSet.get(arg.text)!;
    return b.imported === "default" ? b.local : b.imported;
  }
  if (ts.isPropertyAccessExpression(arg) && ts.isIdentifier(arg.name)) {
    if (ts.isIdentifier(arg.expression) && localSet.has(arg.expression.text)) {
      return arg.name.text;
    }
  }
  return null;
}

function thisOf(ts: typeof import("typescript"), expr: ts.Expression): ThisBinding {
  if (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) {
    return { kind: "method" };
  }
  if (ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression)) {
    const n = expr.expression.name;
    if (ts.isIdentifier(n) && n.text === "call") return { kind: "call" };
    if (ts.isIdentifier(n) && n.text === "apply") return { kind: "apply" };
    if (ts.isIdentifier(n) && n.text === "bind") return { kind: "bind" };
  }
  return { kind: "unbound" };
}

function isBindingScope(ts: typeof import("typescript"), node: ts.Node): boolean {
  return (
    ts.isBlock(node) ||
    ts.isModuleBlock(node) ||
    ts.isCaseBlock(node) ||
    ts.isCatchClause(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isClassStaticBlockDeclaration(node)
  );
}
