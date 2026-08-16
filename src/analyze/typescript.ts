import { existsSync, readFileSync, realpathSync } from "node:fs";
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
import { applySlimmable, usedSliceGraphPure } from "../envelope/slimmable.ts";
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

interface ProgramCtx {
  program: ts.Program;
  checker: ts.TypeChecker;
  options: ts.CompilerOptions;
  host: ts.CompilerHost;
}

interface LocalPending {
  loc: SourceLoc;
  consumerFile: string;
  resolvedFile: string;
  names: Array<{ local: string; imported: string }>;
  namespaceLocal?: string;
  defaultLocal?: string;
}

interface PkgLink {
  file: string;
  specifier: string;
  names: Map<string, string> | "*";
}

interface LocalHop {
  file: string;
  specifier: string;
}

interface CollectExtra {
  localPending: LocalPending[];
  pkgLinks: PkgLink[];
  localHops: LocalHop[];
  programCtx: ProgramCtx | null;
  root: string;
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
  const getSfLite = (file: string) => {
    let sf = sourceCache.get(file);
    if (!sf) {
      const text = readFileSync(file, "utf8");
      const kind = scriptKind(ts, file);
      sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
      sourceCache.set(file, sf);
    }
    return sf;
  };

  const walked = files.filter((file) => ![...ignore].some((g) => file.includes(g)));
  const parsedConfig = readTsConfig(ts, project);
  const programCtx = shouldEscalate(ts, project, walked, getSfLite, parsedConfig)
    ? createScopedProgram(ts, project, walked, parsedConfig)
    : null;

  const getSf = (file: string) => {
    if (programCtx) {
      const fromProg = programCtx.program.getSourceFile(file);
      if (fromProg) return fromProg;
    }
    return getSfLite(file);
  };

  const extra: CollectExtra = {
    localPending: [],
    pkgLinks: [],
    localHops: [],
    programCtx,
    root: project.root,
  };

  for (const file of walked) {
    const sf = getSf(file);
    collectImports(ts, sf, bindings, imports, wanted, extra);
  }

  bindLocalReexports(bindings, extra);

  for (const file of walked) {
    const sf = getSf(file);
    walkUses(ts, sf, bindings, wanted, callSites, unknowns, resultMembers, programCtx?.checker);
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
      const exportName = exportNameOf(b) === "*" ? "*" : exportNameOf(b);
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

  const installedName = family?.name ?? pkg;
  const installedDir = join(project.root, "node_modules", installedName);
  const refuse = refusePackage(installedName, existsSync(installedDir) ? installedDir : null);
  const blockers: string[] = [];
  if (refuse) blockers.push(refuse.why);

  const usedGraphPure = usedSliceGraphPure(
    project.root,
    installedName,
    symbols.map((s) => s.exportName),
  );

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
  env = applySlimmable(env, { usedGraphPure });
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
    collectImports(ts, sf, dummy, imports, null, {
      localPending: [],
      pkgLinks: [],
      localHops: [],
      programCtx: null,
      root: project.root,
    });
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
  bindings: Binding[],
  imports: ImportSite[],
  wanted: Set<string> | null,
  extra: CollectExtra,
): void {
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      const clause = node.importClause;
      const names: string[] = [];
      const pendingNames: Array<{ local: string; imported: string }> = [];
      let kind: ImportKind = "side-effect";
      let namespaceLocal: string | undefined;
      let defaultLocal: string | undefined;
      if (!clause) {
        kind = "side-effect";
      } else {
        if (clause.name) {
          kind = "default";
          names.push("default");
          defaultLocal = clause.name.text;
          pendingNames.push({ local: clause.name.text, imported: "default" });
          pushPkgBinding(bindings, sf, node, specifier, clause.name.text, "default", "default");
        }
        if (clause.namedBindings) {
          if (ts.isNamespaceImport(clause.namedBindings)) {
            kind = "namespace";
            names.push("*");
            namespaceLocal = clause.namedBindings.name.text;
            pushPkgBinding(bindings, sf, node, specifier, namespaceLocal, "*", "namespace");
          } else if (ts.isNamedImports(clause.namedBindings)) {
            kind = "named";
            const map = new Map<string, string>();
            for (const el of clause.namedBindings.elements) {
              const imported = (el.propertyName ?? el.name).text;
              names.push(imported);
              pendingNames.push({ local: el.name.text, imported });
              map.set(imported, imported);
              pushPkgBinding(bindings, sf, node, specifier, el.name.text, imported, "named");
            }
            if (!specifier.startsWith(".") && !specifier.startsWith("#") && parseSpecifier(specifier)) {
              extra.pkgLinks.push({ file: normPath(sf.fileName), specifier, names: map });
            }
          }
        }
      }
      if (specifierMatches(specifier, wanted)) {
        imports.push({ loc: locOf(sf, node), specifier, kind, names });
      }
      if (namespaceLocal && parseSpecifier(specifier) && !specifier.startsWith(".")) {
        extra.pkgLinks.push({ file: normPath(sf.fileName), specifier, names: "*" });
      }
      if (defaultLocal && parseSpecifier(specifier) && !specifier.startsWith(".")) {
        extra.pkgLinks.push({
          file: normPath(sf.fileName),
          specifier,
          names: new Map([["default", "default"]]),
        });
      }
      queueLocalOrAlias(ts, sf, node, specifier, pendingNames, namespaceLocal, defaultLocal, extra);
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
          extra.localHops.push({ file: normPath(sf.fileName), specifier });
        } else {
          extra.pkgLinks.push({ file: normPath(sf.fileName), specifier, names: map });
        }
      } else if (!node.exportClause) {
        if (specifier.startsWith(".")) {
          extra.localHops.push({ file: normPath(sf.fileName), specifier });
        } else {
          extra.pkgLinks.push({ file: normPath(sf.fileName), specifier, names: "*" });
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
        if (specifierMatches(specifier, wanted)) {
          imports.push({
            loc: locOf(sf, node),
            specifier,
            kind: "cjs-require",
            names: ["default"],
          });
        }
        if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
          bindings.push({
            local: parent.name.text,
            imported: "default",
            specifier,
            kind: "cjs-require",
            loc: locOf(sf, node),
          });
        } else if (ts.isVariableDeclaration(parent) && ts.isObjectBindingPattern(parent.name)) {
          const map = new Map<string, string>();
          for (const el of parent.name.elements) {
            if (!ts.isIdentifier(el.name)) continue;
            const imported =
              el.propertyName && ts.isIdentifier(el.propertyName)
                ? el.propertyName.text
                : el.name.text;
            map.set(imported, imported);
            bindings.push({
              local: el.name.text,
              imported,
              specifier,
              kind: "cjs-require",
              loc: locOf(sf, node),
            });
          }
          extra.pkgLinks.push({ file: normPath(sf.fileName), specifier, names: map });
        }
        if (parseSpecifier(specifier)) {
          extra.pkgLinks.push({ file: normPath(sf.fileName), specifier, names: "*" });
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
          const local = localFromImportCall(ts, node);
          if (local) {
            bindings.push({
              local,
              imported: "*",
              specifier,
              kind: "default",
              loc: locOf(sf, node),
            });
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sf);
}

function pushPkgBinding(
  bindings: Binding[],
  sf: ts.SourceFile,
  node: ts.Node,
  specifier: string,
  local: string,
  imported: string,
  kind: ImportKind,
): void {
  if (specifier.startsWith(".") || specifier.startsWith("#")) return;
  if (!parseSpecifier(specifier)) return;
  bindings.push({ local, imported, specifier, kind, loc: locOf(sf, node) });
}

function queueLocalOrAlias(
  ts: typeof import("typescript"),
  sf: ts.SourceFile,
  node: ts.Node,
  specifier: string,
  names: Array<{ local: string; imported: string }>,
  namespaceLocal: string | undefined,
  defaultLocal: string | undefined,
  extra: CollectExtra,
): void {
  let resolved: string | null = null;
  if (specifier.startsWith(".")) {
    resolved = resolveRelative(sf.fileName, specifier);
  } else if (extra.programCtx) {
    const r = ts.resolveModuleName(
      specifier,
      sf.fileName,
      extra.programCtx.options,
      extra.programCtx.host,
    );
    const file = r.resolvedModule?.resolvedFileName;
    if (file && !file.includes("node_modules")) resolved = file;
  }
  if (!resolved) return;
  extra.localPending.push({
    loc: locOf(sf, node),
    consumerFile: sf.fileName,
    resolvedFile: normPath(resolved),
    names,
    namespaceLocal,
    defaultLocal,
  });
}

function bindLocalReexports(bindings: Binding[], extra: CollectExtra): void {
  // ponytail: one hop only — nested barrels stay as local modules
  for (const pending of extra.localPending) {
    applyPkgLinks(pending, pending.resolvedFile, extra, bindings, 0);
  }
}

function applyPkgLinks(
  pending: LocalPending,
  file: string,
  extra: CollectExtra,
  bindings: Binding[],
  hop: number,
): void {
  const nf = normPath(file);
  for (const link of extra.pkgLinks) {
    if (normPath(link.file) !== nf) continue;
    addBindingsFromLink(pending, link, bindings);
  }
  if (hop >= 1) return;
  for (const hopSpec of extra.localHops) {
    if (normPath(hopSpec.file) !== nf) continue;
    const next = resolveRelative(hopSpec.file, hopSpec.specifier);
    if (next) applyPkgLinks(pending, next, extra, bindings, hop + 1);
  }
}

function addBindingsFromLink(pending: LocalPending, link: PkgLink, bindings: Binding[]): void {
  if (link.names === "*") {
    if (pending.namespaceLocal) {
      bindings.push({
        local: pending.namespaceLocal,
        imported: "*",
        specifier: link.specifier,
        kind: "namespace",
        loc: pending.loc,
      });
    }
    if (pending.defaultLocal) {
      bindings.push({
        local: pending.defaultLocal,
        imported: "default",
        specifier: link.specifier,
        kind: "default",
        loc: pending.loc,
      });
    }
    for (const n of pending.names) {
      if (n.imported === "default") continue;
      bindings.push({
        local: n.local,
        imported: n.imported,
        specifier: link.specifier,
        kind: "named",
        loc: pending.loc,
      });
    }
    return;
  }
  for (const n of pending.names) {
    const orig = link.names.get(n.imported);
    if (!orig) continue;
    bindings.push({
      local: n.local,
      imported: orig,
      specifier: link.specifier,
      kind: "named",
      loc: pending.loc,
    });
  }
  if (pending.namespaceLocal) {
    bindings.push({
      local: pending.namespaceLocal,
      imported: "*",
      specifier: link.specifier,
      kind: "namespace",
      loc: pending.loc,
    });
  }
}

function localFromImportCall(
  ts: typeof import("typescript"),
  node: ts.CallExpression,
): string | null {
  let p: ts.Node = node.parent;
  if (ts.isAwaitExpression(p)) p = p.parent;
  if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  return null;
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
    base + ".cjs",
    join(base, "index.ts"),
    join(base, "index.js"),
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
}

function walkUses(
  ts: typeof import("typescript"),
  sf: ts.SourceFile,
  bindings: Binding[],
  wanted: Set<string> | null,
  callSites: CallSite[],
  unknowns: UnknownSite[],
  resultMembers: Map<string, Set<string>>,
  checker?: ts.TypeChecker,
): void {
  const nf = normPath(sf.fileName);
  const bindByLocal = bindings.filter(
    (b) => normPath(b.loc.file) === nf && specifierMatches(b.specifier, wanted),
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

    if (localSet.size && ts.isCallExpression(node)) {
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
          const argShapes = node.arguments.map((a) => {
            if (argIsTsAny(ts, a, checker)) return { kind: "unknown" as const };
            return shapeOf(ts, a, checker);
          });
          const thisBinding = thisOf(ts, node.expression);
          const site: CallSite = {
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
          };
          callSites.push(site);
          const resultLocal = localFromImportCall(ts, node);
          if (resultLocal) resultScopes[resultScopes.length - 1]!.set(resultLocal, site);
          if (spread) {
            unknowns.push({
              id: uid("spread", sf, node),
              loc: locOf(sf, node),
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
              loc: locOf(sf, a),
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

function shapeOf(
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
    return { kind: "array" };
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

function exportNameOf(b: Binding): string {
  if (b.imported !== "*" && b.imported !== "default") return b.imported;
  const fam = resolvePackageFamily(b.specifier);
  if (fam?.subpath) return fam.subpath.split("/")[0]!;
  return b.imported === "default" ? "default" : "*";
}

function normPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
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

function argIsTsAny(
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

function readTsConfig(
  ts: typeof import("typescript"),
  project: Project,
): ts.ParsedCommandLine | null {
  if (!project.tsconfigPath) return null;
  const { config, error } = ts.readConfigFile(project.tsconfigPath, (p) => ts.sys.readFile(p));
  if (error || !config) return null;
  return ts.parseJsonConfigFileContent(
    config,
    ts.sys,
    dirname(project.tsconfigPath),
    undefined,
    project.tsconfigPath,
  );
}

// ponytail: Program is opt-in (paths / exports / literal unions); do not typecheck unused packages
function shouldEscalate(
  ts: typeof import("typescript"),
  project: Project,
  files: string[],
  getSf: (f: string) => ts.SourceFile,
  parsed: ts.ParsedCommandLine | null,
): boolean {
  if (parsed?.options.paths && Object.keys(parsed.options.paths).length) return true;
  for (const file of files) {
    const sf = getSf(file);
    let hit = false;
    const visit = (n: ts.Node) => {
      if (ts.isUnionTypeNode(n) && n.types.some((t) => ts.isLiteralTypeNode(t))) hit = true;
      if (n.kind === ts.SyntaxKind.AnyKeyword) hit = true;
      if (ts.isImportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
        const spec = n.moduleSpecifier.text;
        if (spec.startsWith("#")) hit = true;
        if (packageExportsNeeded(project.root, spec)) hit = true;
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    if (hit) return true;
  }
  return false;
}

function packageExportsNeeded(root: string, spec: string): boolean {
  const parsed = parseSpecifier(spec);
  if (!parsed?.subpath) return false;
  const pj = join(root, "node_modules", parsed.name, "package.json");
  if (!existsSync(pj)) return false;
  try {
    return Boolean(
      (JSON.parse(readFileSync(pj, "utf8")) as { exports?: unknown }).exports,
    );
  } catch {
    return false;
  }
}

function createScopedProgram(
  ts: typeof import("typescript"),
  project: Project,
  files: string[],
  parsed: ts.ParsedCommandLine | null,
): ProgramCtx {
  const options: ts.CompilerOptions = {
    ...(parsed?.options ?? {
      target: ts.ScriptTarget.Latest,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      allowJs: true,
      baseUrl: project.root,
    }),
    noEmit: true,
    skipLibCheck: true,
  };
  const host = ts.createCompilerHost(options, true);
  const program = ts.createProgram(files, options, host);
  return { program, checker: program.getTypeChecker(), options, host };
}
