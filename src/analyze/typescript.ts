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
import { ENVELOPE_VERSION, emptyHyrum } from "../envelope/types.ts";
import { parseSpecifier, resolvePackageFamily, resolvePackageImports } from "./family.ts";
import { refusePackage } from "../scan/refuse.ts";
import { readInstalledVersion } from "../size/estimate.ts";
import { applySlimmable, usedSliceGraphPure } from "../envelope/slimmable.ts";
import { closeEnvelope } from "../envelope/close.ts";
import { walkUses } from "./calls.ts";
import type { Binding, CollectExtra } from "./model.ts";
import { exportNameOf, scriptKind } from "./model.ts";
import { createScopedProgram, readTsConfig, shouldEscalate } from "./program.ts";
import {
  bindLocalReexports,
  collectImports,
  specifierMatches,
  wantedSpecifiers,
} from "./reexports.ts";
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
  };

  for (const file of walked) {
    const sf = getSf(file);
    collectImports(ts, sf, bindings, imports, wanted, extra);
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
  opts: { include?: string[]; ignore?: string[] } = {},
): Map<string, ImportSite[]> {
  const ts = loadTargetTypescript(project.root);
  const files = filterSourceFiles(walkSourceFiles(project.root), project.root, opts);
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
      const resolved = resolvePackageImports(imp.specifier, project.packageJson.imports) ?? imp.specifier;
      const parsed = parseSpecifier(resolved);
      if (!parsed) continue;
      const list = map.get(parsed.name) ?? [];
      list.push(imp);
      map.set(parsed.name, list);
    }
  }
  return map;
}

function detectEnv(project: Project): Envelope["env"] {
  const deps = {
    ...project.packageJson.dependencies,
    ...project.packageJson.devDependencies,
  };
  const env: Envelope["env"] = ["node"];
  if (
    deps["wrangler"] ||
    deps["@cloudflare/workers-types"] ||
    deps["@cloudflare/vitest-pool-workers"] ||
    existsSync(join(project.root, "wrangler.toml"))
  ) {
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
