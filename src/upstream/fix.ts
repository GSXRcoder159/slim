import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnPm } from "../rewrite/lockfile.ts";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import type { CliArgs } from "../cli.ts";
import type { SlimConfig } from "../config.ts";
import { hashEnvelope, envelopeForDisk, type Envelope } from "../envelope/types.ts";
import { EXIT_FAIL, SlimExit } from "../exit.ts";
import { assembleCatalogModule } from "../generate/assemble.ts";
import { matchCatalog } from "../generate/catalog/index.ts";
import { slimRoot } from "../generate/guard.ts";
import { llmConfigFromEnv, generateWithLlm, type LlmConfig } from "../generate/llm.ts";
import { loadPublicApi } from "../generate/public-api.ts";
import { assertValidGenerated, assertSmaller } from "../generate/validate.ts";
import { checkContracts } from "../generate/exports.ts";
import { writeEvidence } from "../evidence/report.ts";
import { emitHardenedGetSetTest, emitStandingTests } from "../evidence/emit-tests.ts";
import { runFuzz, type FuzzReport } from "../fuzz/run.ts";
import { loadTargetTypescript } from "../project.ts";
import { runHardenedTests, runStandingTests } from "../check.ts";
import { standingTestPaths } from "../evidence/paths.ts";
import { MutationTxn } from "../rewrite/transaction.ts";
import { detectRunner } from "../trace/runners.ts";
import { estimatePackageSize } from "../size/estimate.ts";
import { assertDocument, readDocument } from "../schema/documents.ts";
import type { OsvVuln } from "./osv.ts";
import type { NpmLatest } from "./npm.ts";
import type { CreatePrOpts, PrResult } from "../github/pr.ts";
import type { Exposure } from "./slice.ts";
import type { SourceResult } from "./status.ts";
import type { ReplacementRecord } from "./state.ts";

export type ManifestReplacement = ReplacementRecord;

export interface UpstreamFinding {
  package: string;
  pinned: string;
  latest: string;
  id: string;
  summary?: string;
  details?: string;
  exposure: Exposure;
  affectedRange: string;
  usedSymbols: string[];
  mappedEvidence: string;
  upstreamChange: string;
  unmappedReason: string | null;
}

export interface UpstreamDeps {
  cwd?: string;
  queryOsv?: (name: string, version: string) => Promise<SourceResult<OsvVuln[]>>;
  npmLatest?: (name: string) => Promise<SourceResult<NpmLatest>>;
  githubStatus?: () => SourceResult<true>;
  assembleCatalogModule?: (env: Envelope, projectRoot?: string) => string | null;
  matchCatalog?: typeof matchCatalog;
  runFuzz?: (opts: {
    original?: Record<string, Function>;
    replacement?: Record<string, Function>;
    origModule?: string;
    slimModule?: string;
    envelope: Envelope;
    budgetMs: number;
    seed: number;
    workers?: number;
  }) => Promise<FuzzReport>;
  generateWithLlm?: (
    envelope: Envelope,
    publicApi: import("../generate/public-api.ts").PublicApiSpec,
    counterexamples: string[],
    cfg: LlmConfig,
  ) => Promise<{ source: string; promptHash: string }>;
  llmConfigFromEnv?: (env?: NodeJS.ProcessEnv) => LlmConfig | null;
  createPullRequest?: (opts: CreatePrOpts) => Promise<PrResult>;
  installUpstream?: (name: string, version: string) => Promise<string | null>;
  loadOracle?: (
    pkg: string,
    version: string,
    symbols: string[],
  ) => Promise<UpstreamOracle | null>;
  runStandingTests?: (root: string, pkg: string, outDir: string) => void;
  runHardenedTests?: (root: string, moduleRel: string | undefined) => void;
}

export interface UpstreamOracle {
  fns: Record<string, Function>;
  /** "new" = temp-installed latest/patched; "old" = pinned/still-vulnerable project install. */
  kind: "new" | "old";
  tempDir?: string;
}

export interface ApplyUpstreamFixOpts {
  root: string;
  pkg: string;
  rec: ManifestReplacement;
  findings: UpstreamFinding[];
  args: CliArgs;
  config: SlimConfig;
}

export interface ApplyUpstreamFixResult {
  pkg: string;
  regenerated: boolean;
  usedCatalog: boolean;
  fuzzed: boolean;
  fuzzSkipReason: string | null;
  fuzz: { cases: number; comparisons: number; timerCases: number } | null;
  hardenedTest: string | null;
  oracleKind: "new" | "old" | null;
  oracleVersion: string | null;
  residualRisk: string[];
}

export async function canFuzzOracle(
  opts: ApplyUpstreamFixOpts,
  deps: UpstreamDeps = {},
): Promise<boolean> {
  const env = loadEnvelope(opts.root, opts.pkg);
  const symbols = usedSymbols(env, opts.rec);
  const latest = opts.findings[0]?.latest ?? opts.rec.version;
  const oracle = await resolveOracle(opts, deps, latest, symbols);
  if (oracle?.tempDir) {
    try {
      rmSync(oracle.tempDir, { recursive: true, force: true });
    } catch {
      /* tmp */
    }
  }
  return oracle !== null;
}

export async function applyUpstreamFix(
  opts: ApplyUpstreamFixOpts,
  deps: UpstreamDeps = {},
  sharedTxn?: MutationTxn,
): Promise<ApplyUpstreamFixResult> {
  const env = loadEnvelope(opts.root, opts.pkg);
  const symbols = usedSymbols(env, opts.rec);
  const catalog = (deps.matchCatalog ?? matchCatalog)(opts.pkg, symbols);
  const llmCfg = (deps.llmConfigFromEnv ?? llmConfigFromEnv)();
  const assemble = deps.assembleCatalogModule ?? assembleCatalogModule;
  const genLlm = deps.generateWithLlm ?? generateWithLlm;
  const fuzzImpl = deps.runFuzz ?? runFuzz;
  const standing = deps.runStandingTests ?? runStandingTests;
  const hardened = deps.runHardenedTests ?? runHardenedTests;
  const ts = loadTs(opts.root);

  let source: string | null = null;
  let usedCatalog = false;
  let pub = undefined as ReturnType<typeof loadPublicApi> | undefined;
  let gen = undefined as { source: string; promptHash: string } | undefined;

  if (catalog.missing.length === 0 && catalog.matched.length) {
    source = assemble(env, opts.root);
    if (!source) {
      throw new SlimExit(EXIT_FAIL, `catalog matched but assemble failed for ${opts.pkg}`);
    }
    usedCatalog = true;
    assertValidGenerated(ts, source, env);
    const contracts = checkContracts(ts, source, env);
    if (!contracts.ok) {
      throw new SlimExit(EXIT_FAIL, `missing named export: ${contracts.errors.join("; ")}`);
    }
  } else if (llmCfg) {
    pub = loadPublicApi(opts.root, opts.pkg, env.package.subpath);
    gen = await genLlm(env, pub, advisoryAbstracts(opts.findings), llmCfg);
    source = gen.source;
    assertValidGenerated(ts, source, env);
    const contracts = checkContracts(ts, source, env);
    if (!contracts.ok) {
      throw new SlimExit(EXIT_FAIL, `missing named export: ${contracts.errors.join("; ")}`);
    }
  }

  if (!source) {
    throw new SlimExit(EXIT_FAIL, `could not regenerate ${opts.pkg}: no catalog match and no LLM key`);
  }

  let oracleTemp: string | undefined;
  let srcTemp: string | undefined;
  const txn = sharedTxn ?? new MutationTxn(opts.root);
  const ownsTxn = !sharedTxn;
  try {
    srcTemp = mkdtempSync(join(tmpdir(), "slim-up-src-"));
    const tmpSlim = join(srcTemp, "slim.mjs");
    writeFileSync(
      tmpSlim,
      ts.transpileModule(source, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
          moduleResolution: ts.ModuleResolutionKind.NodeNext,
        },
        fileName: join(opts.root, opts.rec.module),
      }).outputText,
    );
    const replacement = await loadReplacementFns(tmpSlim);

    const latest = opts.findings[0]?.latest ?? opts.rec.version;
    const oracle = await resolveOracle(opts, deps, latest, symbols);
    oracleTemp = oracle?.tempDir;

    if (!oracle) {
      throw new SlimExit(EXIT_FAIL, "verification unavailable: no installable oracle");
    }

    const originalMin = estimatePackageSize(oracle.tempDir ?? opts.root, opts.pkg).minBytes;
    assertSmaller(Buffer.byteLength(source), originalMin ?? 0, false);

    const budgetMs = opts.args.budgetMs ?? Math.min(opts.config.budgetMs, 5_000);
    const report = await fuzzImpl({
      original: oracle.fns,
      replacement: replacement ?? {},
      envelope: env,
      budgetMs,
      seed: 1,
      workers: 1,
    });
    const dropProto = usedCatalog && oracle.kind === "old";
    const disagreements = dropProto
      ? report.disagreements.filter((d) => !isProtoPollutionCase(d))
      : report.disagreements;
    if (disagreements.length) {
      const first = disagreements[0]!;
      const msg = usedCatalog
        ? `catalog disagreement (Slim bug, not LLM-patched): ${first.symbol} ${first.reason}`
        : `fuzz disagreements remain: ${first.symbol} ${first.reason}`;
      throw new SlimExit(EXIT_FAIL, msg);
    }

    if (replacement && (typeof replacement.get === "function" || typeof replacement.set === "function")) {
      assertHardenedGetSet(replacement);
    }

    const pinTo = oracle.kind === "new" ? latest : opts.rec.version;
    const envWrite: Envelope = oracle.kind === "new" ? { ...env, package: { ...env.package, version: pinTo } } : env;
    const moduleAbs = join(opts.root, opts.rec.module);
    const pkgSlimDir = join(opts.root, ".slim", opts.pkg);
    const standingPaths = standingTestPaths(opts.root, opts.pkg, opts.config.outDir);
    const standingAbs = standingPaths.tsAbs;
    const standingRel = standingPaths.tsRel;
    const hardenedAbs = join(
      opts.root,
      opts.rec.module.replace(/\.(ts|js|mjs|cjs)$/, ".hardened.test.ts"),
    );

    txn.writeFile(moduleAbs, source);
    const runner = detectRunner(opts.root);
    const testRunner = runner.kind === "vitest" ? "vitest" : "node:test";
    txn.prepareWrite(standingAbs);
    txn.snapshot(join(opts.root, "package.json"));
    emitStandingTests({
      root: opts.root,
      outDir: opts.config.outDir,
      pkg: opts.pkg,
      env: envWrite,
      traces: env.traces,
      runner: testRunner,
      moduleSpecifier: toRelativeSpecifier(standingAbs, moduleAbs),
    });
    txn.prepareWrite(hardenedAbs);
    emitHardenedGetSetTest({ root: opts.root, moduleRel: opts.rec.module, runner: testRunner });

    txn.prepareWrite(join(pkgSlimDir, "evidence.md"));
    txn.prepareWrite(join(pkgSlimDir, "evidence.json"));
    const written = writeEvidence({
      root: opts.root,
      env: envWrite,
      replacementBytes: Buffer.byteLength(source),
      originalMin,
      fuzz: {
        cases: report.cases,
        comparisons: report.comparisons,
        timerCases: report.timerCases,
        tracesReplayed: report.tracesReplayed,
        wallMs: report.wallMs,
        seed: report.seed,
        disagreements: report.disagreements.length,
      },
      catalogIds: usedCatalog ? catalog.matched.map((m) => m.id) : [],
      coverageHoles: [],
      generation: usedCatalog
        ? {
            kind: "catalog",
            catalogIds: catalog.matched.map((m) => m.id),
            attempts: 1,
            specSource: "catalog",
            counterexamples: [],
          }
        : {
            kind: "llm",
            catalogIds: [],
            provider: llmCfg?.kind,
            model: llmCfg?.model,
            promptHash: gen?.promptHash,
            attempts: 1,
            specSource: pub?.source ?? "envelope-only",
            limitation: pub?.limitation,
            counterexamples: [],
          },
      revert: {
        package: envWrite.package.name,
        version: envWrite.package.version,
        module: opts.rec.module,
        tests: standingRel.replace(/\\/g, "/"),
        cjsCompanion: null,
        rewrites: [],
        lockfile: null,
        installCommand: "npm install",
      },
    });

    const disk = envelopeForDisk(envWrite);
    assertDocument("envelope", disk);
    txn.writeFile(join(pkgSlimDir, "envelope.json"), JSON.stringify(disk, null, 2) + "\n");

    const nextHash = hashEnvelope(envWrite);
    updateManifest(opts.root, opts.pkg, opts.rec, {
      envelopeHash: nextHash,
      version: oracle.kind === "new" ? pinTo : undefined,
    }, txn);
    if (oracle.kind === "new") bumpSlimJsonPin(opts.root, opts.pkg, pinTo, txn);

    standing(opts.root, opts.pkg, opts.config.outDir, undefined, Boolean(opts.args.json));
    hardened(opts.root, opts.rec.module, undefined, Boolean(opts.args.json));

    if (ownsTxn) txn.commit();
    return {
      pkg: opts.pkg,
      regenerated: true,
      usedCatalog,
      fuzzed: true,
      fuzzSkipReason: null,
      fuzz: {
        cases: report.cases,
        comparisons: report.comparisons,
        timerCases: report.timerCases,
      },
      hardenedTest: hardenedAbs,
      oracleKind: oracle.kind,
      oracleVersion: pinTo,
      residualRisk: written.residualRisk,
    };
  } catch (err) {
    if (ownsTxn) txn.rollback();
    throw err;
  } finally {
    if (srcTemp) {
      try {
        rmSync(srcTemp, { recursive: true, force: true });
      } catch {
        /* tmp */
      }
    }
    if (oracleTemp) {
      try {
        rmSync(oracleTemp, { recursive: true, force: true });
      } catch {
        /* tmp */
      }
    }
  }
}

export function advisoryAbstracts(findings: UpstreamFinding[]): string[] {
  const lines = [
    "Advisory abstracts (clean-room; OriginalSourceGuard: never ingest original .js):",
  ];
  for (const f of findings) {
    lines.push([f.id, f.summary, f.details].filter(Boolean).join("\n"));
  }
  return lines;
}

export function assertHardenedGetSet(fns: Record<string, Function>): void {
  const proto = Object.prototype as { polluted?: unknown };
  const before = Object.prototype.hasOwnProperty("polluted");
  delete proto.polluted;
  try {
    if (typeof fns.set === "function") {
      fns.set({}, "__proto__.polluted", true);
      fns.set({}, ["__proto__", "polluted"], true);
    }
    if (typeof fns.get === "function") {
      fns.get({ a: 1 }, "__proto__.polluted");
    }
    if (Object.prototype.hasOwnProperty("polluted") || proto.polluted !== undefined) {
      throw new SlimExit(EXIT_FAIL, "hardened get/set allowed Object.prototype pollution");
    }
    if (before !== Object.prototype.hasOwnProperty("polluted")) {
      throw new SlimExit(EXIT_FAIL, "hardened get/set allowed Object.prototype pollution");
    }
  } finally {
    delete proto.polluted;
  }
}

export { emitHardenedGetSetTest } from "../evidence/emit-tests.ts";

export async function installUpstreamInTemp(name: string, version: string): Promise<string | null> {
  const spec = `${name}@${version}`;
  const view = spawnPm("npm", ["view", spec, "version"], {
    encoding: "utf8",
    timeout: 20_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (view.status !== 0) return null;
  const dir = mkdtempSync(join(tmpdir(), "slim-up-oracle-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "slim-upstream-oracle", private: true }),
  );
  const inst = spawnPm(
    "npm",
    ["install", spec, "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", dir],
    { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] },
  );
  if (inst.status !== 0) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* keep */
    }
    return null;
  }
  return dir;
}

function usedSymbols(env: Envelope, rec: ManifestReplacement): string[] {
  const fromEnv = env.symbols
    .map((s) => s.exportName)
    .filter((n) => n !== "*" && n !== "default" && n !== "(scan)");
  return fromEnv.length ? fromEnv : rec.symbols.filter((n) => n !== "*" && n !== "(scan)");
}

function loadEnvelope(root: string, pkg: string): Envelope {
  const p = join(root, ".slim", pkg, "envelope.json");
  return readDocument("envelope", p, `envelope ${p}`) as Envelope;
}

function loadTs(root: string): typeof import("typescript") {
  try {
    return loadTargetTypescript(root);
  } catch {
    return loadTargetTypescript(slimRoot());
  }
}

async function resolveOracle(
  opts: ApplyUpstreamFixOpts,
  deps: UpstreamDeps,
  latest: string,
  symbols: string[],
): Promise<UpstreamOracle | null> {
  if (deps.loadOracle) return deps.loadOracle(opts.pkg, latest, symbols);
  const install = deps.installUpstream ?? installUpstreamInTemp;
  let tempDir: string | undefined;
  try {
    const dir = await install(opts.pkg, latest);
    if (dir) {
      tempDir = dir;
      const loaded = loadOriginalFromRoot(dir, opts.pkg, symbols);
      if (loaded) return { fns: loaded, kind: "new", tempDir };
    }
  } catch {
    /* fall back to pinned / project install */
  }
  if (tempDir) {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* keep */
    }
  }
  const old = loadOriginalFromRoot(opts.root, opts.pkg, symbols);
  if (old) return { fns: old, kind: "old" };
  return null;
}

function loadOriginalFromRoot(
  root: string,
  pkg: string,
  symbols: string[],
): Record<string, Function> | null {
  try {
    const req = createRequire(join(root, "package.json"));
    const mod = req(pkg) as Record<string, unknown>;
    return pickFns(mod, symbols);
  } catch {
    return null;
  }
}

function pickFns(mod: Record<string, unknown>, symbols: string[]): Record<string, Function> | null {
  const out: Record<string, Function> = {};
  const def = mod.default as Record<string, unknown> | undefined;
  for (const s of symbols) {
    const fn = (mod[s] ?? def?.[s]) as unknown;
    if (typeof fn === "function") out[s] = fn as Function;
  }
  return Object.keys(out).length ? out : null;
}

async function loadReplacementFns(absJs: string): Promise<Record<string, Function> | null> {
  try {
    const href = pathToFileURL(absJs).href + `?slim=${Date.now()}`;
    const mod = (await import(href)) as Record<string, unknown>;
    return pickFns(mod, Object.keys(mod)) ?? pickFns(mod, ["get", "set", "default"]);
  } catch {
    return null;
  }
}

function isProtoPollutionCase(d: { args: unknown[]; reason: string; symbol?: string }): boolean {
  const blob = `${d.symbol ?? ""} ${d.reason} ${JSON.stringify(d.args)}`;
  return /__proto__|prototype.?pollution|constructor\.prototype/i.test(blob);
}

function toRelativeSpecifier(fromFile: string, toFile: string): string {
  let rel = relative(dirname(fromFile), toFile).replace(/\\/g, "/");
  if (!rel.startsWith(".")) rel = "./" + rel;
  return rel;
}

function updateManifest(
  root: string,
  pkg: string,
  rec: ManifestReplacement,
  next: { envelopeHash: string; version?: string },
  txn: MutationTxn,
): void {
  rec.envelopeHash = next.envelopeHash;
  if (next.version) rec.version = next.version;
  const p = join(root, ".slim", "manifest.json");
  if (!existsSync(p)) return;
  const man = JSON.parse(readFileSync(p, "utf8")) as {
    schemaVersion?: number;
    replacements: Record<string, ManifestReplacement>;
  };
  man.schemaVersion = 1;
  if (man.replacements?.[pkg]) {
    man.replacements[pkg] = {
      ...man.replacements[pkg],
      envelopeHash: next.envelopeHash,
      ...(next.version ? { version: next.version } : {}),
    };
    assertDocument("manifest", man);
    txn.writeFile(p, JSON.stringify(man, null, 2) + "\n");
  }
}

function bumpSlimJsonPin(root: string, pkg: string, version: string, txn: MutationTxn): void {
  const p = join(root, "slim.json");
  if (!existsSync(p)) return;
  const slim = JSON.parse(readFileSync(p, "utf8")) as {
    replacements?: Record<string, { version: string; envelope: string; module: string }>;
  };
  if (slim.replacements?.[pkg]) {
    slim.replacements[pkg] = { ...slim.replacements[pkg], version };
    assertDocument("slim", slim);
    txn.writeFile(p, JSON.stringify(slim, null, 2) + "\n");
  }
}
