import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type ts from "typescript";
import type { Project } from "../project.ts";
import { loadTargetTypescript, walkSourceFiles, filterSourceFiles } from "../project.ts";
import type {
  CallSite,
  Envelope,
  ImportSite,
  SymbolEnvelope,
  UnknownSite,
} from "../envelope/types.ts";
import { ENVELOPE_VERSION } from "../envelope/types.ts";
import { parseSpecifier, resolvePackageFamily, resolvePackageImports } from "./family.ts";
import { refusePackage } from "../scan/refuse.ts";
import { readInstalledVersion } from "../size/estimate.ts";
import { applySlimmable, usedSliceGraphPure } from "../envelope/slimmable.ts";
import { closeEnvelope } from "../envelope/close.ts";
import { walkUses } from "./calls.ts";
import { collectFileAliases } from "./flow.ts";
import type { Binding, CollectExtra } from "./model.ts";
import { exportNameOf, scriptKind } from "./model.ts";
import { createScopedProgram, readTsConfig, shouldEscalate } from "./program.ts";
import {
  collectImports,
  specifierMatches,
  wantedSpecifiers,
} from "./reexports.ts";
import { bindLocalReexports } from "./reexport-bind.ts";
import { inferHyrum } from "./shapes.ts";

export interface AnalyzeOptions {
  allowUnknown?: boolean;
  ignore?: string[];
  include?: string[];
}

export function analyzePackage(
  project: Project,
  pkg: string,
  opts: AnalyzeOptions = {},
): Envelope {
  const ts = loadTargetTypescript(project.root);
  const files = filterSourceFiles(walkSourceFiles(project.root), project.root, {
    include: opts.include,
    ignore: opts.ignore,
  });
  const wanted = wantedSpecifiers(pkg);

  const bindings: Binding[] = [];
  const imports: ImportSite[] = [];
  const callSites: CallSite[] = [];
  const unknowns: UnknownSite[] = [];
  const resultMembers = new Map<string, Set<string>>();
  const clockSymbols = new Set(["debounce", "throttle", "delay", "now"]);
  let clock = false;
  let cryptoRandom = pkg === "uuid" || pkg === "nanoid";
  const envKinds = detectEnv(project, files);

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

  const walked = files;
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
    typeOnly: [],
    unknowns,
    wanted,
  };

  for (const file of walked) {
    const sf = getSf(file);
    collectImports(ts, sf, bindings, imports, wanted, extra);
  }

  for (const file of walked) {
    collectFileAliases(ts, getSf(file), bindings, extra);
  }

  bindLocalReexports(bindings, extra);

  for (const file of walked) {
    const sf = getSf(file);
    walkUses(ts, sf, bindings, wanted, callSites, unknowns, resultMembers, extra, programCtx?.checker);
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
      if (exportNameOf(b) !== "*") continue;
      unknowns.push({
        id: `ns:${b.loc.file}:${b.loc.line}`,
        loc: b.loc,
        kind: "namespace-escape",
        detail: `namespace import of ${b.specifier} with no observed members`,
        widensTo: "all-exports",
        traceObservedMembers: null,
      });
    }
  }
  accountUnobservedImports(imports, callSites, unknowns, wanted);

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
      staticCallSiteIds: [],
      tracedCallSiteIds: [],
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

export function collectPackageSpecifiers(
  project: Project,
  opts: { include?: string[]; ignore?: string[] } = {},
): { runtime: Map<string, ImportSite[]>; typeOnly: Map<string, ImportSite[]> } {
  const ts = loadTargetTypescript(project.root);
  const files = filterSourceFiles(walkSourceFiles(project.root), project.root, opts);
  const runtime = new Map<string, ImportSite[]>();
  const typeOnly = new Map<string, ImportSite[]>();
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
    const extra: CollectExtra = {
      localPending: [],
      pkgLinks: [],
      localHops: [],
      programCtx: null,
      root: project.root,
      typeOnly: [],
      unknowns: [],
      wanted: null,
    };
    collectImports(ts, sf, dummy, imports, null, extra);
    addSpecifierSites(runtime, imports, project.packageJson.imports);
    addSpecifierSites(typeOnly, extra.typeOnly, project.packageJson.imports);
  }
  return { runtime, typeOnly };
}

export function collectImportSpecifiers(
  project: Project,
  opts: { include?: string[]; ignore?: string[] } = {},
): Map<string, ImportSite[]> {
  return collectPackageSpecifiers(project, opts).runtime;
}

function accountUnobservedImports(
  imports: ImportSite[],
  callSites: CallSite[],
  unknowns: UnknownSite[],
  wanted: Set<string> | null,
): void {
  const seen = new Set(unknowns.map((u) => u.id));
  const push = (u: UnknownSite) => {
    if (seen.has(u.id)) return;
    seen.add(u.id);
    unknowns.push(u);
  };
  for (const imp of imports) {
    if (!specifierMatches(imp.specifier, wanted)) continue;
    if (imp.kind !== "side-effect") continue;
    push({
      id: `side:${imp.loc.file}:${imp.loc.line}:${imp.loc.column}`,
      loc: imp.loc,
      kind: "side-effect-import",
      detail: `side-effect import of ${imp.specifier} has no represented init behavior`,
      widensTo: "refuse",
      traceObservedMembers: null,
    });
  }
  if (callSites.length > 0) return;
  const observedUnknown = unknowns.some(
    (u) =>
      u.kind !== "unresolved-reexport" &&
      u.kind !== "side-effect-import" &&
      u.kind !== "unobserved-import",
  );
  if (observedUnknown) return;
  const hasNsEscape = unknowns.some((u) => u.kind === "namespace-escape");
  for (const imp of imports) {
    if (!specifierMatches(imp.specifier, wanted)) continue;
    if (imp.kind === "side-effect") continue;
    if (imp.kind === "namespace" && hasNsEscape) continue;
    push({
      id: `unobs:${imp.loc.file}:${imp.loc.line}:${imp.loc.column}`,
      loc: imp.loc,
      kind: "unobserved-import",
      detail: `import of ${imp.specifier} has no represented runtime use`,
      widensTo: "refuse",
      traceObservedMembers: null,
    });
  }
}

function addSpecifierSites(
  map: Map<string, ImportSite[]>,
  sites: ImportSite[],
  importMap: unknown,
): void {
  for (const imp of sites) {
    const resolved = resolvePackageImports(imp.specifier, importMap) ?? imp.specifier;
    const parsed = parseSpecifier(resolved);
    if (!parsed) continue;
    const list = map.get(parsed.name) ?? [];
    list.push(imp);
    map.set(parsed.name, list);
  }
}

function detectEnv(project: Project, files: string[]): Envelope["env"] {
  const deps = {
    ...project.packageJson.dependencies,
    ...project.packageJson.devDependencies,
  };
  const tags: Envelope["env"] = [];
  const engines = (project.packageJson as { engines?: { node?: string } }).engines?.node;
  let hasNodeSpecifier = false;
  for (const f of files) {
    try {
      if (/\bnode:/.test(readFileSync(f, "utf8"))) {
        hasNodeSpecifier = true;
        break;
      }
    } catch {
      /* ignore */
    }
  }
  if (deps["@types/node"] || engines || hasNodeSpecifier) tags.push("node");
  if (
    deps["wrangler"] ||
    deps["@cloudflare/workers-types"] ||
    deps["@cloudflare/vitest-pool-workers"] ||
    existsSync(join(project.root, "wrangler.toml"))
  ) {
    tags.push("worker");
  }
  if (deps["jsdom"] || deps["@testing-library/dom"]) tags.push("jsdom");
  const browserField = project.packageJson.browser;
  const hasDomRuntime = Boolean(deps["react-dom"] || deps["preact"]);
  let hasDomLib = false;
  if (project.tsconfigPath) {
    try {
      const raw = readFileSync(project.tsconfigPath, "utf8");
      if (/"DOM"/i.test(raw) || /'DOM'/i.test(raw)) hasDomLib = true;
    } catch {
      /* ignore */
    }
  }
  if (browserField || hasDomRuntime || (hasDomLib && !tags.includes("node"))) {
    tags.push("browser");
  }
  if (tags.length === 0) tags.push("unknown");
  return tags;
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
