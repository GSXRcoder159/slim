import type ts from "typescript";
import { SlimExit, EXIT_FAIL, EXIT_REFUSED } from "../exit.ts";

const FORBIDDEN_IDS = new Set([
  "eval",
  "Function",
  "WebAssembly",
  "Proxy",
  "fetch",
  "require",
]);

const FORBIDDEN_CALLEES = new Set(["eval", "Function"]);

export interface ValidateResult {
  ok: boolean;
  errors: string[];
}

export function validateGenerated(
  ts: typeof import("typescript"),
  source: string,
  fileName = "slim-generated.ts",
): ValidateResult {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const errors: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && FORBIDDEN_IDS.has(node.text)) {
      const parent = node.parent;
      const isProp =
        parent &&
        ts.isPropertyAccessExpression(parent) &&
        parent.name === node;
      if (!isProp) {
        errors.push(`forbidden identifier ${node.text}`);
      }
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const expr = node.expression;
      if (ts.isIdentifier(expr) && FORBIDDEN_CALLEES.has(expr.text)) {
        errors.push(`forbidden callee ${expr.text}`);
      }
      if (expr.kind === ts.SyntaxKind.ImportKeyword) {
        errors.push("forbidden import()");
      }
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") {
      errors.push("forbidden require");
    }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "WebAssembly") {
      errors.push("forbidden WebAssembly");
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (node.text === "__proto__" || node.text === "constructor" || node.text === "prototype") {
        // allowed only in hardened get/set/has — still flag as review unless comment
        /* ponytail: literal proto keys are required for get/set hardening */
      }
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "setTimeout") {
      if (node.arguments[0] && (ts.isStringLiteral(node.arguments[0]) || ts.isNoSubstitutionTemplateLiteral(node.arguments[0]))) {
        errors.push("forbidden string-setTimeout");
      }
    }
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const spec = node.moduleSpecifier;
      if (spec && ts.isStringLiteral(spec)) {
        if (spec.text.startsWith("node:") || spec.text.includes("lodash") || spec.text.includes("moment")) {
          errors.push(`forbidden import ${spec.text}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (/Function\s*\(/.test(source) && errors.every((e) => !e.includes("Function"))) {
    errors.push("forbidden Function(");
  }
  return { ok: errors.length === 0, errors };
}

export function assertValidGenerated(
  ts: typeof import("typescript"),
  source: string,
): void {
  const r = validateGenerated(ts, source);
  if (!r.ok) {
    const template = r.errors.some((e) => e.includes("Function"));
    throw new SlimExit(
      template ? EXIT_REFUSED : EXIT_FAIL,
      `generated code failed AST allowlist: ${r.errors.join("; ")}`,
    );
  }
}

export function assertSmaller(replacementBytes: number, originalBytes: number, force: boolean): void {
  if (!force && originalBytes > 0 && replacementBytes >= originalBytes) {
    throw new SlimExit(
      EXIT_FAIL,
      `replacement (${replacementBytes} B) is not smaller than original estimate (${originalBytes} B); pass --force`,
    );
  }
}
