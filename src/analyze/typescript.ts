import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type ts from "typescript";
import type { Project } from "../project.ts";
import { loadTargetTypescript, walkSourceFiles } from "../project.ts";
import type {
  ArgShape,
  CallSite,
  Envelope,
  ImportKind,
  ImportSite,
  SourceLoc,
  SymbolEnvelope,
  ThisBinding,
  UnknownSite,
} from "../envelope/types.ts";
import { ENVELOPE_VERSION, emptyHyrum } from "../envelope/types.ts";
import { parseSpecifier, resolvePackageFamily } from "./family.ts";
import { refusePackage } from "../scan/refuse.ts";
import { readInstalledVersion } from "../size/estimate.ts";
import { applySlimmable } from "../envelope/slimmable.ts";
import { closeEnvelope } from "../envelope/close.ts";

export interface AnalyzeOptions {
  allowUnknown?: boolean;
  ignore?: string[];
}

interface Binding {
  local: string;
  imported: string; // "*" for namespace, "default" for default
  specifier: string;
  kind: ImportKind;
  loc: SourceLoc;
}

export function analyzePackage(
  project: Project,
  pkg: string,
  opts: AnalyzeOptions = {},
): Envelope {
  const ts = loadTargetTypescript(project.root);
  const files = walkSourceFiles(project.root);
  const ignore = new Set(opts.ignore ?? []);
  const wanted = wantedSpecifiers(pkg);

  const bindings: Binding[] = [];
  const imports: ImportSite[] = [];
  const callSites: CallSite[] = [];
  const unknowns: UnknownSite[] = [];
  const resultMembers = new Map<string, Set<string>>();
  const clockSymbols = new Set(["debounce", "throttle", "delay", "now"]);
  let clock = false;
  let cryptoRandom = pkg === "uuid" || pkg === "nanoid";
  const envKinds = detectEnv(project);

  const sourceCache = new Map<string, ts.SourceFile>();
  const getSf = (file: string) => {
    let sf = sourceCache.get(file);
    if (!sf) {
      const text = readFileSync(file, "utf8");
      const kind = scriptKind(ts, file);
      sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
      sourceCache.set(file, sf);
    }
    return sf;
  };

  const localReexports = new Map<string, { specifier: string; names: Map<string, string> }>();

  for (const file of files) {
    if ([...ignore].some((g) => file.includes(g))) continue;
    const sf = getSf(file);
    collectImports(ts, sf, project.root, bindings, imports, wanted, localReexports);
  }

  followLocalReexports(ts, project, getSf, bindings, imports, wanted, localReexports);

  for (const file of files) {
    if ([...ignore].some((g) => file.includes(g))) continue;
    const sf = getSf(file);
    walkUses(ts, sf, project.root, bindings, wanted, callSites, unknowns, resultMembers);
  }

  const byExport = new Map<string, CallSite[]>();
  for (const c of callSites) {
    const list = byExport.get(c.exportName) ?? [];
    list.push(c);
    byExport.set(c.exportName, list);
    if (clockSymbols.has(c.exportName)) clock = true;
  }

  const family = resolvePackageFamily(pkg);
  const version =
    readInstalledVersion(project.root, family?.name ?? pkg) ??
    installedFromPkg(project, family?.name ?? pkg);

  const symbols: SymbolEnvelope[] = [...byExport.entries()].map(([exportName, sites]) => ({
    exportName,
    packages: [
      {
        name: family?.name ?? pkg,
        version,
        family: family?.family ?? pkg,
        subpath: family?.subpath ?? "",
      },
    ],
    callSites: sites,
    resultMembers: [...(resultMembers.get(exportName) ?? [])],
    hyrum: inferHyrum(exportName, sites),
    coverage: { callSitesStatic: sites.length, callSitesTraced: 0 },
  }));

  if (symbols.length === 0) {
    for (const b of bindings) {
      if (!specifierMatches(b.specifier, wanted)) continue;
      const exportName = b.imported === "*" ? "*" : b.imported;
      if (byExport.has(exportName === "default" ? "default" : exportName)) continue;
      if (exportName === "*") {
        unknowns.push({
          id: `ns:${b.loc.file}:${b.loc.line}`,
          loc: b.loc,
          kind: "namespace-escape",
          detail: `namespace import of ${b.specifier} with no observed members`,
          widensTo: "all-exports",
          traceObservedMembers: null,
        });
        continue;
      }
      symbols.push({
        exportName: exportName === "default" ? "default" : exportName,
        packages: [
          {
            name: family?.name ?? pkg,
            version,
            family: family?.family ?? pkg,
            subpath: family?.subpath ?? "",
          },
        ],
        callSites: [],
        resultMembers: [],
        hyrum: emptyHyrum(),
        coverage: { callSitesStatic: 0, callSitesTraced: 0 },
      });
    }
  }

  const refuse = refusePackage(family?.name ?? pkg);
  const blockers: string[] = [];
  if (refuse) blockers.push(refuse.why);

  let env: Envelope = {
    schemaVersion: ENVELOPE_VERSION,
    package: {
      name: family?.name ?? pkg,
      version,
      family: family?.family ?? pkg,
      subpath: family?.subpath ?? "",
    },
    env: envKinds,
    imports: imports.filter((i) => specifierMatches(i.specifier, wanted)),
    symbols,
    unknowns,
    traces: [],
    closure: {
      confidence: "open",
      readyToGenerate: false,
      untracedCallSiteIds: [],
      reason: "",
    },
    slimmable: { score: 0, verdict: refuse ? "refuse" : "review", blockers, reasons: [] },
    clock,
    cryptoRandom,
  };
  env = applySlimmable(env);
  env = closeEnvelope(env, { allowUnknown: opts.allowUnknown });
  return env;
}

export function collectImportSpecifiers(
  project: Project,
): Map<string, ImportSite[]> {
  const ts = loadTargetTypescript(project.root);
  const files = walkSourceFiles(project.root);
  const map = new Map<string, ImportSite[]>();
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const sf = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      scriptKind(ts, file),
    );
    const dummy: Binding[] = [];
    const imports: ImportSite[] = [];
    collectImports(ts, sf, project.root, dummy, imports, null, new Map());
    for (const imp of imports) {
      const parsed = parseSpecifier(imp.specifier);
      const key = parsed?.name ?? imp.specifier;
      const list = map.get(key) ?? [];
      list.push(imp);
      map.set(key, list);
    }
  }
  return map;
}

function wantedSpecifiers(pkg: string): Set<string> | null {
  const fam = resolvePackageFamily(pkg);
  if (!fam) return new Set([pkg]);
  const set = new Set<string>([pkg, fam.name, fam.family]);
  if (fam.family === "lodash") {
    set.add("lodash");
    set.add("lodash-es");
    set.add("underscore");
  }
  return set;
}

function specifierMatches(specifier: string, wanted: Set<string> | null): boolean {
  if (!wanted) return true;
  const fam = resolvePackageFamily(specifier);
  if (!fam) return wanted.has(specifier);
  if (wanted.has(specifier) || wanted.has(fam.name) || wanted.has(fam.family)) return true;
  if (fam.family === "lodash" && [...wanted].some((w) => resolvePackageFamily(w)?.family === "lodash")) {
    return true;
  }
  return false;
}

function scriptKind(ts: typeof import("typescript"), file: string): ts.ScriptKind {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs")) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function locOf(sf: ts.SourceFile, node: ts.Node): SourceLoc {
  const start = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  const end = sf.getLineAndCharacterOfPosition(node.getEnd());
  return {
    file: sf.fileName,
    line: start.line + 1,
    column: start.character + 1,
    endLine: end.line + 1,
    endColumn: end.character + 1,
  };
}

function collectImports(
  ts: typeof import("typescript"),
  sf: ts.SourceFile,
  root: string,
  bindings: Binding[],
  imports: ImportSite[],
  wanted: Set<string> | null,
  localReexports: Map<string, { specifier: string; names: Map<string, string> }>,
): void {
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      const clause = node.importClause;
      const names: string[] = [];
      let kind: ImportKind = "side-effect";
      if (!clause) {
        kind = "side-effect";
      } else {
        if (clause.name) {
          kind = "default";
          names.push("default");
          bindings.push({
            local: clause.name.text,
            imported: "default",
            specifier,
            kind: "default",
            loc: locOf(sf, node),
          });
        }
        if (clause.namedBindings) {
          if (ts.isNamespaceImport(clause.namedBindings)) {
            kind = "namespace";
            names.push("*");
            bindings.push({
              local: clause.namedBindings.name.text,
              imported: "*",
              specifier,
              kind: "namespace",
              loc: locOf(sf, node),
            });
          } else if (ts.isNamedImports(clause.namedBindings)) {
            kind = "named";
            for (const el of clause.namedBindings.elements) {
              const imported = (el.propertyName ?? el.name).text;
              names.push(imported);
              bindings.push({
                local: el.name.text,
                imported,
                specifier,
                kind: "named",
                loc: locOf(sf, node),
              });
            }
          }
        }
      }
      if (specifierMatches(specifier, wanted)) {
        imports.push({ loc: locOf(sf, node), specifier, kind, names });
      }
    }

    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      const names: string[] = [];
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        const map = new Map<string, string>();
        for (const el of node.exportClause.elements) {
          const exported = el.name.text;
          const orig = (el.propertyName ?? el.name).text;
          names.push(orig);
          map.set(exported, orig);
        }
        if (specifier.startsWith(".")) {
          localReexports.set(sf.fileName + ":" + specifier, { specifier, names: map });
        }
      } else if (!node.exportClause) {
        if (specifier.startsWith(".")) {
          localReexports.set(sf.fileName + ":" + specifier, {
            specifier,
            names: new Map([["*", "*"]]),
          });
        }
      }
      if (specifierMatches(specifier, wanted)) {
        imports.push({
          loc: locOf(sf, node),
          specifier,
          kind: node.exportClause ? "named" : "namespace",
          names: names.length ? names : ["*"],
        });
      }
    }

    if (ts.isCallExpression(node)) {
      const cal = node.expression;
      if (
        ts.isIdentifier(cal) &&
        cal.text === "require" &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        const specifier = node.arguments[0].text;
        const parent = node.parent;
        let local: string | null = null;
        if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
          local = parent.name.text;
        }
        if (specifierMatches(specifier, wanted)) {
          imports.push({
            loc: locOf(sf, node),
            specifier,
            kind: "cjs-require",
            names: ["default"],
          });
        }
        if (local) {
          bindings.push({
            local,
            imported: "default",
            specifier,
            kind: "cjs-require",
            loc: locOf(sf, node),
          });
        }
      }
      if (cal.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0]) {
        const arg = node.arguments[0];
        if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
          const specifier = arg.text;
          if (specifierMatches(specifier, wanted)) {
            imports.push({
              loc: locOf(sf, node),
              specifier,
              kind: "default",
              names: ["default"],
            });
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sf);
  void root;
}

function followLocalReexports(
  ts: typeof import("typescript"),
  project: Project,
  getSf: (f: string) => ts.SourceFile,
  bindings: Binding[],
  imports: ImportSite[],
  wanted: Set<string> | null,
  localReexports: Map<string, { specifier: string; names: Map<string, string> }>,
): void {
  // ponytail: one hop only — nested barrels stay as local modules
  for (const [key, re] of localReexports) {
    const fromFile = key.split(":")[0]!;
    const resolved = resolveRelative(fromFile, re.specifier);
    if (!resolved || !existsSync(resolved)) continue;
    const sf = getSf(resolved);
    collectImports(ts, sf, project.root, bindings, imports, wanted, new Map());
  }
}

function resolveRelative(fromFile: string, spec: string): string | null {
  const dir = dirname(fromFile);
  const base = join(dir, spec);
  const candidates = [
    base,
    base + ".ts",
    base + ".js",
    base + ".tsx",
    base + ".mjs",
    join(base, "index.ts"),
    join(base, "index.js"),
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
}

function walkUses(
  ts: typeof import("typescript"),
  sf: ts.SourceFile,
  root: string,
  bindings: Binding[],
  wanted: Set<string> | null,
  callSites: CallSite[],
  unknowns: UnknownSite[],
  resultMembers: Map<string, Set<string>>,
): void {
  const bindByLocal = bindings.filter(
    (b) => b.loc.file === sf.fileName && specifierMatches(b.specifier, wanted),
  );
  const localSet = new Map(bindByLocal.map((b) => [b.local, b]));
  if (!localSet.size) return;

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "eval") {
      unknowns.push({
        id: uid("eval", sf, node),
        loc: locOf(sf, node),
        kind: "eval",
        detail: "eval()",
        widensTo: "refuse",
        traceObservedMembers: null,
      });
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Function") {
      unknowns.push({
        id: uid("fn", sf, node),
        loc: locOf(sf, node),
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
          loc: locOf(sf, node),
          kind: "dynamic-specifier",
          detail: "import(non-literal)",
          widensTo: "refuse",
          traceObservedMembers: null,
        });
      }
    }

    if (ts.isCallExpression(node)) {
      const info = resolveCallee(ts, node.expression, localSet);
      if (info) {
        if (info.dynamic) {
          unknowns.push({
            id: uid("dyn", sf, node),
            loc: locOf(sf, node),
            kind: "dynamic-member",
            detail: `computed member on ${info.exportName}`,
            widensTo: "all-exports",
            traceObservedMembers: null,
          });
        } else {
          const spread = node.arguments.some((a) => ts.isSpreadElement(a));
          const argc = node.arguments.length;
          const argShapes = node.arguments.map((a) => shapeOf(ts, a));
          const thisBinding = thisOf(ts, node.expression);
          callSites.push({
            id: uid("call", sf, node),
            loc: locOf(sf, node),
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
          });
        }
      }
      for (const arg of node.arguments) {
        const escaped = asBindingEscape(ts, arg, localSet);
        if (escaped) {
          unknowns.push({
            id: uid("esc", sf, arg),
            loc: locOf(sf, arg),
            kind: "binding-escape",
            detail: `${escaped} passed as callback (iteratee arity 3 assumed for get)`,
            widensTo: "full-signature",
            traceObservedMembers: null,
          });
          if (escaped === "get" || escaped.endsWith(".get")) {
            callSites.push({
              id: uid("mapget", sf, arg),
              loc: locOf(sf, arg),
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
      const info = resolveCallee(ts, node.expression, localSet);
      if (info && !info.dynamic && ts.isIdentifier(node.name)) {
        const parentCall = ts.isCallExpression(node.parent) && node.parent.expression === node;
        if (!parentCall) {
          const set = resultMembers.get(info.exportName) ?? new Set();
          set.add(node.name.text);
          resultMembers.set(info.exportName, set);
        }
      }
      if (ts.isIdentifier(node.expression) && localSet.has(node.expression.text)) {
        const b = localSet.get(node.expression.text)!;
        if (b.imported === "*" || b.imported === "default") {
          if (ts.isIdentifier(node.name) && node.parent && ts.isCallExpression(node.parent) && node.parent.expression === node) {
            // handled in resolveCallee
          }
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
            loc: locOf(sf, node),
            kind: "dynamic-member",
            detail: `computed access ${obj.text}[...]`,
            widensTo: "all-exports",
            traceObservedMembers: null,
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sf);
  void root;
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
    if (b.imported === "*") {
      return { exportName: "*", memberPath: [], dynamic: false };
    }
    return {
      exportName: b.imported === "default" ? "default" : b.imported,
      memberPath: b.imported === "default" ? [] : [b.imported],
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

function shapeOf(ts: typeof import("typescript"), node: ts.Expression): ArgShape {
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
    return { kind: "array" };
  }
  if (ts.isObjectLiteralExpression(node)) {
    const props: Record<string, ArgShape> = {};
    for (const p of node.properties) {
      if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) {
        props[p.name.text] = shapeOf(ts, p.initializer as ts.Expression);
      } else if (ts.isPropertyAssignment(p) && ts.isStringLiteral(p.name)) {
        props[p.name.text] = shapeOf(ts, p.initializer as ts.Expression);
      }
    }
    return { kind: "object", props };
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    return { kind: "function", fnArity: node.parameters.length };
  }
  return { kind: "any" };
}

function inferHyrum(exportName: string, sites: CallSite[]) {
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

function uid(prefix: string, sf: ts.SourceFile, node: ts.Node): string {
  return `${prefix}:${relative(process.cwd(), sf.fileName)}:${node.getStart(sf)}`;
}

function detectEnv(project: Project): Envelope["env"] {
  const deps = {
    ...project.packageJson.dependencies,
    ...project.packageJson.devDependencies,
  };
  const env: Envelope["env"] = ["node"];
  if (deps["wrangler"] || deps["@cloudflare/workers-types"] || deps["@cloudflare/vitest-pool-workers"]) {
    env.push("worker");
  }
  if (deps["jsdom"] || deps["@testing-library/dom"]) env.push("jsdom");
  return env;
}

function installedFromPkg(project: Project, name: string): string {
  const deps = {
    ...project.packageJson.dependencies,
    ...project.packageJson.devDependencies,
    ...project.packageJson.optionalDependencies,
  };
  const raw = deps[name] ?? "";
  return raw.replace(/^[~^>=<\s]+/, "") || "unknown";
}
