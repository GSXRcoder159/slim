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
  "ArrayBuffer",
  "DataView",
  "URL",
  "URLSearchParams",
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
  const allowBuffer = envelope?.env.includes("node") === true;
  const hardened = hasHardenedGetSetHas(ts, sf);

  if (exportsTimerWrapper(ts, sf)) {
    checkCachedTimers(ts, sf, errors);
  }

  const moduleScope: Scope = { names: new Set(["arguments"]) };
  collectScopeBindings(ts, sf, moduleScope.names, { letConst: true, vars: true, functions: true });

  const visit = (node: ts.Node, stack: Scope[]) => {
    if (entersFunctionScope(ts, node)) {
      const fnScope: Scope = { names: new Set() };
      if (!ts.isArrowFunction(node)) fnScope.names.add("arguments");
      if (node.name && ts.isIdentifier(node.name)) fnScope.names.add(node.name.text);
      for (const p of node.parameters) addBinding(ts, p.name, fnScope.names);
      if (node.body) collectVarsAndFuncs(ts, node.body, fnScope.names);
      const inner = [...stack, fnScope];
      for (const p of node.parameters) {
        if (p.initializer) visit(p.initializer, inner);
        if (p.type) visit(p.type, inner);
      }
      if (node.body) visit(node.body, inner);
      return;
    }
    if (ts.isBlock(node)) {
      const blockScope: Scope = { names: new Set() };
      collectScopeBindings(ts, node, blockScope.names, { letConst: true, vars: false, functions: false });
      const inner = [...stack, blockScope];
      for (const stmt of node.statements) visit(stmt, inner);
      return;
    }
    if (ts.isCatchClause(node)) {
      const catchScope: Scope = { names: new Set() };
      if (node.variableDeclaration) addBinding(ts, node.variableDeclaration.name, catchScope.names);
      visit(node.block, [...stack, catchScope]);
      return;
    }
    if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      const forScope: Scope = { names: new Set() };
      const init =
        ts.isForStatement(node) ? node.initializer : ts.isForInStatement(node) || ts.isForOfStatement(node) ? node.initializer : undefined;
      if (init && ts.isVariableDeclarationList(init)) {
        for (const d of init.declarations) addBinding(ts, d.name, forScope.names);
      }
      const inner = [...stack, forScope];
      ts.forEachChild(node, (c) => visit(c, inner));
      return;
    }
    if (ts.isIdentifier(node)) {
      checkIdentifier(ts, node, stack, allowBuffer, errors);
    }
    if (ts.isPropertyAccessExpression(node)) {
      checkPropertyAccess(ts, node, allowBuffer, errors);
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
    if (ts.isCallExpression(node)) {
      checkPrototypeMutationCall(ts, node, errors);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      checkPrototypeMutationAssign(ts, node, errors);
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
        const kind = ts.isExportDeclaration(node) ? "export" : "import";
        errors.push(`forbidden ${kind} ${spec.text}`);
      }
    }
    ts.forEachChild(node, (c) => visit(c, stack));
  };
  visit(sf, [moduleScope]);
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

interface Scope {
  names: Set<string>;
}

function entersFunctionScope(
  ts: typeof import("typescript"),
  node: ts.Node,
): node is ts.FunctionLikeDeclaration {
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

function collectScopeBindings(
  ts: typeof import("typescript"),
  container: ts.SourceFile | ts.Block,
  names: Set<string>,
  opts: { letConst: boolean; vars: boolean; functions: boolean },
): void {
  for (const stmt of container.statements) {
    if (opts.functions && ts.isFunctionDeclaration(stmt) && stmt.name) names.add(stmt.name.text);
    if (ts.isClassDeclaration(stmt) && stmt.name) names.add(stmt.name.text);
    if (ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt) || ts.isEnumDeclaration(stmt)) {
      names.add(stmt.name.text);
    }
    if (ts.isVariableStatement(stmt)) {
      const flags = stmt.declarationList.flags;
      const isVar = !(flags & ts.NodeFlags.Let) && !(flags & ts.NodeFlags.Const);
      if ((isVar && opts.vars) || (!isVar && opts.letConst)) {
        for (const d of stmt.declarationList.declarations) addBinding(ts, d.name, names);
      }
    }
    if (ts.isImportDeclaration(stmt) && stmt.importClause) {
      if (stmt.importClause.name) names.add(stmt.importClause.name.text);
      const nb = stmt.importClause.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) names.add(nb.name.text);
      if (nb && ts.isNamedImports(nb)) {
        for (const el of nb.elements) names.add(el.name.text);
      }
    }
  }
}

function collectVarsAndFuncs(ts: typeof import("typescript"), root: ts.Node, names: Set<string>): void {
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name) names.add(node.name.text);
    if (entersFunctionScope(ts, node) && node !== root) return;
    if (ts.isVariableStatement(node)) {
      const flags = node.declarationList.flags;
      const isVar = !(flags & ts.NodeFlags.Let) && !(flags & ts.NodeFlags.Const);
      if (isVar) {
        for (const d of node.declarationList.declarations) addBinding(ts, d.name, names);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
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

function isLocal(stack: Scope[], name: string): boolean {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i]!.names.has(name)) return true;
  }
  return false;
}

function checkIdentifier(
  ts: typeof import("typescript"),
  node: ts.Identifier,
  stack: Scope[],
  allowBuffer: boolean,
  errors: string[],
): void {
  if (isPropertyNameId(ts, node) || isLabel(ts, node) || inTypePosition(ts, node)) return;
  const name = node.text;
  if (FORBIDDEN_IDS.has(name)) {
    errors.push(`forbidden identifier ${name}`);
    return;
  }
  if (isLocal(stack, name) || ALLOWED_GLOBALS.has(name)) return;
  if (name === "Buffer") {
    if (!allowBuffer) errors.push("forbidden identifier Buffer (node env only)");
    return;
  }
  errors.push(`identifier not on allowlist: ${name}`);
}

function isPropertyNameId(ts: typeof import("typescript"), node: ts.Identifier): boolean {
  const p = node.parent;
  if (!p) return false;
  if (ts.isPropertyDeclaration(p) && p.name === node) return true;
  if (ts.isPropertySignature(p) && p.name === node) return true;
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
  allowBuffer: boolean,
  errors: string[],
): void {
  if (ts.isIdentifier(node.expression) && node.expression.text === "Reflect") {
    if (!REFLECT_METHODS.has(node.name.text)) {
      errors.push(`forbidden Reflect.${node.name.text}`);
    }
  }
  if (ts.isIdentifier(node.expression) && HOST_GLOBALS.has(node.expression.text)) {
    const prop = node.name.text;
    if (ALLOWED_GLOBALS.has(prop)) return;
    if (prop === "Buffer" && allowBuffer) return;
    errors.push(`forbidden ${node.expression.text}.${prop}`);
  }
}

function checkPrototypeMutationCall(
  ts: typeof import("typescript"),
  node: ts.CallExpression,
  errors: string[],
): void {
  const expr = node.expression;
  if (
    ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === "Object" &&
    expr.name.text === "setPrototypeOf"
  ) {
    errors.push("prototype-mutation: Object.setPrototypeOf");
    return;
  }
  if (
    ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === "Object" &&
    expr.name.text === "defineProperty"
  ) {
    const target = node.arguments[0];
    if (target && isPrototypeObject(ts, target)) {
      errors.push("prototype-mutation: Object.defineProperty on a prototype");
    }
  }
}

function checkPrototypeMutationAssign(
  ts: typeof import("typescript"),
  node: ts.BinaryExpression,
  errors: string[],
): void {
  const left = node.left;
  if (ts.isPropertyAccessExpression(left) && left.name.text === "__proto__") {
    errors.push("prototype-mutation: __proto__ assignment");
    return;
  }
  if (
    ts.isElementAccessExpression(left) &&
    (ts.isStringLiteral(left.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(left.argumentExpression)) &&
    left.argumentExpression.text === "__proto__"
  ) {
    errors.push("prototype-mutation: __proto__ assignment");
  }
}

function isPrototypeObject(ts: typeof import("typescript"), expr: ts.Expression): boolean {
  return ts.isPropertyAccessExpression(expr) && expr.name.text === "prototype";
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
