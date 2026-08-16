import type ts from "typescript";
import { SlimExit, EXIT_FAIL, EXIT_REFUSED } from "../exit.ts";
import type { Envelope } from "../envelope/types.ts";

const FORBIDDEN_IDS = new Set([
  "eval",
  "Function",
  "WebAssembly",
  "Proxy",
  "fetch",
  "require",
]);

const FORBIDDEN_CALLEES = new Set(["eval", "Function"]);

const ALLOWED_GLOBALS = new Set([
  "Math",
  "Number",
  "String",
  "JSON",
  "Map",
  "Set",
  "Reflect",
  "Date",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "Promise",
  "Object",
  "Array",
  "Boolean",
  "Symbol",
  "RegExp",
  "Error",
  "TypeError",
  "RangeError",
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "undefined",
  "NaN",
  "Infinity",
  "globalThis",
  "crypto",
  "arguments",
  "Uint8Array",
]);

const REFLECT_METHODS = new Set(["get", "set", "has", "ownKeys"]);
const THROW_CTORS = new Set(["Error", "TypeError", "RangeError"]);
const TIMER_FNS = new Set(["setTimeout", "clearTimeout", "setInterval", "clearInterval"]);
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const HOST_GLOBALS = new Set(["globalThis", "global", "window"]);

export interface ValidateOptions {
  fileName?: string;
  envelope?: Envelope;
}

export interface ValidateResult {
  ok: boolean;
  errors: string[];
}

export function validateGenerated(
  ts: typeof import("typescript"),
  source: string,
  fileNameOrOpts: string | ValidateOptions = "slim-generated.ts",
): ValidateResult {
  const opts: ValidateOptions =
    typeof fileNameOrOpts === "string" ? { fileName: fileNameOrOpts } : (fileNameOrOpts ?? {});
  const fileName = opts.fileName ?? "slim-generated.ts";
  const envelope = opts.envelope;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const errors: string[] = [];
  const locals = collectLocals(ts, sf);
  const allowBuffer = envelope?.env.includes("node") === true;
  const hardened = hasHardenedGetSetHas(ts, sf);

  if (exportsTimerWrapper(ts, sf)) {
    checkCachedTimers(ts, sf, errors);
  }

  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node)) {
      checkIdentifier(ts, node, locals, allowBuffer, errors);
    }
    if (ts.isPropertyAccessExpression(node)) {
      checkPropertyAccess(ts, node, errors);
    }
    if (ts.isObjectLiteralExpression(node)) {
      checkDangerousKeys(ts, node, hardened, errors);
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
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "setTimeout"
    ) {
      if (
        node.arguments[0] &&
        (ts.isStringLiteral(node.arguments[0]) || ts.isNoSubstitutionTemplateLiteral(node.arguments[0]))
      ) {
        errors.push("forbidden string-setTimeout");
      }
    }
    if (ts.isThrowStatement(node)) {
      checkThrow(ts, node, errors);
    }
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const spec = node.moduleSpecifier;
      if (spec && ts.isStringLiteral(spec)) {
        if (
          spec.text.startsWith("node:") ||
          spec.text.includes("lodash") ||
          spec.text.includes("moment") ||
          spec.text.includes("underscore")
        ) {
          errors.push(`forbidden import ${spec.text}`);
        } else if (ts.isImportDeclaration(node)) {
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
  envelope?: Envelope,
): void {
  const r = validateGenerated(ts, source, { envelope });
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

function collectLocals(ts: typeof import("typescript"), root: ts.Node): Set<string> {
  const names = new Set<string>(["arguments"]);
  const visit = (node: ts.Node) => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)
    ) {
      if (node.name && ts.isIdentifier(node.name)) names.add(node.name.text);
    }
    if (ts.isClassDeclaration(node) && node.name) names.add(node.name.text);
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) {
      names.add(node.name.text);
    }
    if ("parameters" in node && Array.isArray((node as ts.SignatureDeclaration).parameters)) {
      for (const p of (node as ts.SignatureDeclaration).parameters) {
        addBinding(ts, p.name, names);
      }
    }
    if (ts.isVariableDeclaration(node) || ts.isParameter(node)) {
      addBinding(ts, node.name, names);
    }
    if (ts.isCatchClause(node) && node.variableDeclaration) {
      addBinding(ts, node.variableDeclaration.name, names);
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return names;
}

function addBinding(ts: typeof import("typescript"), name: ts.BindingName, names: Set<string>): void {
  if (ts.isIdentifier(name)) {
    names.add(name.text);
    return;
  }
  for (const el of name.elements) {
    if (ts.isBindingElement(el)) addBinding(ts, el.name, names);
  }
}

function checkIdentifier(
  ts: typeof import("typescript"),
  node: ts.Identifier,
  locals: Set<string>,
  allowBuffer: boolean,
  errors: string[],
): void {
  if (isPropertyNameId(ts, node) || isLabel(ts, node) || inTypePosition(ts, node)) return;
  const name = node.text;
  if (FORBIDDEN_IDS.has(name)) {
    errors.push(`forbidden identifier ${name}`);
    return;
  }
  if (locals.has(name) || ALLOWED_GLOBALS.has(name)) return;
  if (name === "Buffer") {
    if (!allowBuffer) errors.push("forbidden identifier Buffer (node env only)");
    return;
  }
  errors.push(`identifier not on allowlist: ${name}`);
}

function isPropertyNameId(ts: typeof import("typescript"), node: ts.Identifier): boolean {
  const p = node.parent;
  if (!p) return false;
  if (ts.isPropertyAccessExpression(p) && p.name === node) return true;
  if (ts.isPropertyAssignment(p) && p.name === node) return true;
  if (ts.isMethodDeclaration(p) && p.name === node) return true;
  if (ts.isGetAccessorDeclaration(p) && p.name === node) return true;
  if (ts.isSetAccessorDeclaration(p) && p.name === node) return true;
  if (ts.isEnumMember(p) && p.name === node) return true;
  if (ts.isQualifiedName(p) && p.right === node) return true;
  if (ts.isBindingElement(p) && p.propertyName === node) return true;
  // Shorthand `{ foo }` is a value reference of `foo`.
  return false;
}

function isLabel(ts: typeof import("typescript"), node: ts.Identifier): boolean {
  const p = node.parent;
  return Boolean(p && ts.isLabeledStatement(p) && p.label === node);
}

function inTypePosition(ts: typeof import("typescript"), node: ts.Identifier): boolean {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (ts.isTypeQueryNode(cur)) return false;
    if (ts.isTypeNode(cur)) return true;
    if (
      ts.isTypeAliasDeclaration(cur) ||
      ts.isInterfaceDeclaration(cur) ||
      ts.isTypeParameterDeclaration(cur) ||
      ts.isHeritageClause(cur) ||
      ts.isExpressionWithTypeArguments(cur)
    ) {
      return true;
    }
    if (
      (ts.isAsExpression(cur) || ts.isTypeAssertionExpression(cur) || ts.isSatisfiesExpression(cur)) &&
      inside(cur.type, node)
    ) {
      return true;
    }
    if (
      (ts.isVariableDeclaration(cur) ||
        ts.isParameter(cur) ||
        ts.isFunctionDeclaration(cur) ||
        ts.isMethodDeclaration(cur) ||
        ts.isPropertyDeclaration(cur) ||
        ts.isPropertySignature(cur) ||
        ts.isIndexSignatureDeclaration(cur) ||
        ts.isConstructorDeclaration(cur)) &&
      cur.type &&
      inside(cur.type, node)
    ) {
      return true;
    }
    if (isFunctionLike(ts, cur) && cur.typeParameters) {
      for (const tp of cur.typeParameters) {
        if (inside(tp, node)) return true;
      }
    }
    cur = cur.parent;
  }
  return false;
}

function isFunctionLike(
  ts: typeof import("typescript"),
  node: ts.Node,
): node is ts.SignatureDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function inside(root: ts.Node, target: ts.Node): boolean {
  let cur: ts.Node | undefined = target;
  while (cur) {
    if (cur === root) return true;
    cur = cur.parent;
  }
  return false;
}

function checkPropertyAccess(
  ts: typeof import("typescript"),
  node: ts.PropertyAccessExpression,
  errors: string[],
): void {
  if (ts.isIdentifier(node.expression) && node.expression.text === "Reflect") {
    if (!REFLECT_METHODS.has(node.name.text)) {
      errors.push(`forbidden Reflect.${node.name.text}`);
    }
  }
  if (
    ts.isIdentifier(node.expression) &&
    HOST_GLOBALS.has(node.expression.text) &&
    FORBIDDEN_IDS.has(node.name.text)
  ) {
    errors.push(`forbidden ${node.expression.text}.${node.name.text}`);
  }
}

function checkDangerousKeys(
  ts: typeof import("typescript"),
  node: ts.ObjectLiteralExpression,
  hardened: boolean,
  errors: string[],
): void {
  if (hardened) return;
  for (const prop of node.properties) {
    if (
      ts.isPropertyAssignment(prop) ||
      ts.isShorthandPropertyAssignment(prop) ||
      ts.isMethodDeclaration(prop) ||
      ts.isGetAccessorDeclaration(prop) ||
      ts.isSetAccessorDeclaration(prop)
    ) {
      const text = propertyNameText(ts, prop.name);
      if (text && DANGEROUS_KEYS.has(text)) {
        errors.push(`forbidden literal key ${text}`);
      }
    }
  }
}

function propertyNameText(ts: typeof import("typescript"), name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  if (
    ts.isComputedPropertyName(name) &&
    (ts.isStringLiteral(name.expression) || ts.isNoSubstitutionTemplateLiteral(name.expression))
  ) {
    return name.expression.text;
  }
  return undefined;
}

function hasHardenedGetSetHas(ts: typeof import("typescript"), sf: ts.SourceFile): boolean {
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && /^(get|set|has)$/.test(stmt.name.text)) {
      return true;
    }
    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && /^(get|set|has)$/.test(d.name.text)) return true;
      }
    }
  }
  return false;
}

function checkThrow(ts: typeof import("typescript"), node: ts.ThrowStatement, errors: string[]): void {
  const expr = node.expression;
  if (ts.isIdentifier(expr)) return;
  if (
    ts.isNewExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    THROW_CTORS.has(expr.expression.text)
  ) {
    return;
  }
  errors.push("forbidden throw");
}

function exportsTimerWrapper(ts: typeof import("typescript"), sf: ts.SourceFile): boolean {
  for (const stmt of sf.statements) {
    if (
      ts.isFunctionDeclaration(stmt) &&
      stmt.name &&
      /^(debounce|throttle)$/.test(stmt.name.text)
    ) {
      return true;
    }
    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && /^(debounce|throttle)$/.test(d.name.text)) return true;
      }
    }
  }
  return false;
}

function checkCachedTimers(
  ts: typeof import("typescript"),
  sf: ts.SourceFile,
  errors: string[],
): void {
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const d of stmt.declarationList.declarations) {
      if (d.initializer && initializerCachesTimer(ts, d.initializer)) {
        errors.push("cached-timers: module-scope capture of Date.now/setTimeout/clearTimeout");
        return;
      }
    }
  }
}

function initializerCachesTimer(ts: typeof import("typescript"), init: ts.Expression): boolean {
  if (isTimerRef(ts, init)) return true;
  if (ts.isCallExpression(init) && isDateNow(ts, init.expression) && init.arguments.length === 0) {
    return true;
  }
  return false;
}

function isTimerRef(ts: typeof import("typescript"), node: ts.Expression): boolean {
  if (ts.isIdentifier(node) && TIMER_FNS.has(node.text)) return true;
  if (isDateNow(ts, node)) return true;
  if (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    HOST_GLOBALS.has(node.expression.text) &&
    (TIMER_FNS.has(node.name.text) || node.name.text === "Date")
  ) {
    return true;
  }
  return false;
}

function isDateNow(ts: typeof import("typescript"), node: ts.Node): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "Date" &&
    node.name.text === "now"
  );
}
