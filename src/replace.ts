import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { resolveScriptFile, scriptSpawnOpts } from "./rewrite/lockfile.ts";
import { randomInt } from "node:crypto";
import { tmpdir } from "node:os";
import type { CliArgs } from "./cli.ts";
import { EXIT_FAIL, EXIT_OK, EXIT_REFUSED, EXIT_USAGE, SlimExit } from "./exit.ts";
import { loadConfig } from "./config.ts";
import { loadProject, walkSourceFiles, filterSourceFiles, loadTargetTypescript } from "./project.ts";
import { analyzePackage } from "./analyze/index.ts";
import { closeEnvelope } from "./envelope/close.ts";
import { hashEnvelope } from "./envelope/hash.ts";
import { envelopeForDisk } from "./envelope/types.ts";
import type { Envelope, SlimValue, TraceEvent } from "./envelope/types.ts";
import { assertDocument } from "./schema/documents.ts";
import { refusePackage, formatRefuse } from "./scan/refuse.ts";
import { estimatePackageSize } from "./size/estimate.ts";
import { matchCatalog } from "./generate/catalog/index.ts";
import { catalogBoundary } from "./generate/catalog/boundary.ts";
import { assembleCatalogModule } from "./generate/assemble.ts";
import { withGeneratedHeader } from "./generate/header.ts";
import { llmConfigFromEnv, generateWithLlm } from "./generate/llm.ts";
import { assertValidGenerated, assertSmaller } from "./generate/validate.ts";
import { loadPublicApi, type PublicApiSpec } from "./generate/public-api.ts";
import { runFuzz, type FuzzReport } from "./fuzz/run.ts";
import { repairLoop } from "./generate/repair.ts";
import { rewriteSpecifiers as spliceSpecifiers } from "./rewrite/splice.ts";
import { removeDependencyKey } from "./rewrite/packagejson.ts";
import { installCommandFor, refreshLockfile, shouldRefreshLockfile } from "./rewrite/lockfile.ts";
import { writeEvidence } from "./evidence/report.ts";
import { emitHardenedGetSetTest, emitStandingTests } from "./evidence/emit-tests.ts";
import { maybeCreatePullRequest, prBodyFromEvidence, REPLACE_PR_LABELS } from "./github/pr.ts";
import { detectRunner } from "./trace/runners.ts";
import { runTraces, withLocalBinPath, writeTracesMeta } from "./trace/run.ts";
import { MutationTxn, lockfilePath } from "./rewrite/transaction.ts";
import { rewriteSpecifiers as envelopeSpecifiers, removeDependencyNames } from "./rewrite/siblings.ts";
import {
  assertInsideRoot,
  assertNoOutputCollision,
  fileBase,
  isSafeToRewrite,
} from "./rewrite/paths.ts";
import { emitCjsSource, isCjsConsumer } from "./rewrite/cjs-emit.ts";
import type { RevertPlan } from "./rewrite/revert.ts";

export { withLocalBinPath, writeTracesMeta };

/** ponytail: qualification inject; not a public flag */
function injectFail(step: string): void {
  if (process.env.SLIM_INJECT_FAIL === step) {
    throw new SlimExit(EXIT_FAIL, `injected failure: ${step}`);
  }
}

export async function runReplace(args: CliArgs): Promise<number> {
  if (!args.pkg) throw new SlimExit(EXIT_USAGE, "usage: slim replace <pkg>");
  const project = loadProject();
  const config = loadConfig(project.root);
  const refuse = refusePackage(args.pkg);
  if (refuse && !args.force) {
    process.stderr.write(formatRefuse(refuse) + "\n");
    return EXIT_REFUSED;
  }

  process.stderr.write(`analyzing ${args.pkg}…\n`);
  let env = analyzePackage(project, args.pkg, {
    allowUnknown: args.allowUnknown,
    include: config.include,
    ignore: config.ignore,
  });

  if (!args.noTrace) {
    const traceDir = mkdtempSync(join(tmpdir(), "slim-trace-"));
    try {
      env = runTraces(project.root, args.pkg, env, { traceDir });
    } finally {
      rmSync(traceDir, { recursive: true, force: true });
    }
    env = closeEnvelope(env, { allowUnknown: args.allowUnknown });
  } else {
    env = closeEnvelope(env, { allowUnknown: args.allowUnknown, staticOnly: true });
  }
  assertNoPollutionDependence(env.traces);

  if (!env.symbols.length) {
    const rec = config.replacements[args.pkg] ?? config.replacements[env.package.name];
    if (rec?.module && existsSync(join(project.root, rec.module))) {
      process.stdout.write(`already replaced ${env.package.name} (${rec.module}); nothing to do\n`);
      return EXIT_OK;
    }
  }

  if (env.slimmable.verdict === "refuse" && !args.force) {
    throw new SlimExit(
      EXIT_REFUSED,
      `refused ${args.pkg}: ${env.slimmable.blockers.join("; ") || env.closure.reason}`,
    );
  }
  if (!env.closure.readyToGenerate && !args.force) {
    throw new SlimExit(EXIT_REFUSED, `envelope not closed: ${env.closure.reason}`);
  }
  if (!env.symbols.length) {
    throw new SlimExit(EXIT_FAIL, `no used symbols found for ${args.pkg}`);
  }

  const symbols = env.symbols.map((s) => s.exportName).filter((n) => n !== "*" && n !== "(scan)");
  const catalog = matchCatalog(args.pkg, symbols);
  const boundary = catalogBoundary(env, args.pkg);
  if (boundary && !args.force) {
    throw new SlimExit(EXIT_REFUSED, formatRefuse(boundary));
  }
  const llm = llmConfigFromEnv();
  let source: string;
  let catalogIds: string[] = [];
  let usedCatalog = false;
  let publicApi: PublicApiSpec | undefined;
  let promptHash: string | undefined;
  let genAttempts = 1;
  let genExamples: string[] = [];

  if (!args.llm && catalog.missing.length === 0 && catalog.matched.length) {
    const assembled = assembleCatalogModule(env, project.root);
    if (!assembled) {
      throw new SlimExit(EXIT_FAIL, "catalog matched but assemble failed");
    }
    source = assembled;
    catalogIds = catalog.matched.map((m) => m.id);
    usedCatalog = true;
  } else if (args.templateOnly || (!llm && catalog.missing.length)) {
    throw new SlimExit(
      EXIT_REFUSED,
      `no catalog for ${catalog.missing.join(", ") || args.pkg} and no LLM key (set OPENAI_API_KEY or ANTHROPIC_API_KEY)`,
    );
  } else if (!llm) {
    throw new SlimExit(EXIT_REFUSED, "LLM requested but no API key");
  } else {
    process.stderr.write("generating with LLM (clean-room)…\n");
    publicApi = loadPublicApi(project.root, env.package.name, env.package.subpath);
    const gen = await generateWithLlm(env, publicApi, [], llm);
    source = withGeneratedHeader(gen.source, env, { promptHash: gen.promptHash });
    promptHash = gen.promptHash;
  }

  const ts = loadTargetTypescript(project.root);
  assertValidGenerated(ts, source, env);
  const originalSize = estimatePackageSize(project.root, env.package.name);
  const replacementBytes = Buffer.byteLength(source);
  if (!usedCatalog) {
    assertSmaller(replacementBytes, originalSize.minBytes ?? 0, args.force);
  }

  const seed = args.seed ?? randomInt(1, 2 ** 31);
  const budget = args.budgetMs ?? config.budgetMs;
  const outDir = args.out ?? config.outDir;
  const outAbs = assertInsideRoot(project.root, outDir);
  const slimPath = join(outAbs, `${fileBase(env.package.name)}.ts`);
  assertNoOutputCollision(project.root, slimPath, env.package.name);

  if (args.dryRun) {
    printDryRun(env, source, catalogIds);
    return EXIT_OK;
  }

  const transpile = (src: string) =>
    ts.transpileModule(src, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
      },
      fileName: slimPath,
    }).outputText;
  const tmpSlim = join(tmpdir(), `slim-fuzz-${process.pid}-${randomInt(1e9)}.mjs`);
  const fuzzSource = async (src: string, hashExtra = ""): Promise<FuzzReport> => {
    writeFileSync(tmpSlim, transpile(src));
    return runFuzz({
      origModule: env.package.name,
      slimModule: tmpSlim,
      slimHash: `${hashEnvelope(env)}:${seed}${hashExtra}`,
      envelope: env,
      budgetMs: budget,
      seed,
      workers: args.workers ?? undefined,
      allowFlaky: args.allowFlaky,
      projectRoot: project.root,
    });
  };

  process.stderr.write(`fuzzing (budget ${budget}ms, seed ${seed})…\n`);
  let report: FuzzReport;
  try {
    if (!usedCatalog && llm) {
      publicApi ??= loadPublicApi(project.root, env.package.name, env.package.subpath);
      const repaired = await repairLoop({
        envelope: env,
        publicApi,
        initial: source,
        maxAttempts: args.maxAttempts,
        llm,
        projectRoot: project.root,
        catalog: false,
        fuzz: (src) => fuzzSource(src),
      });
      source = repaired.source;
      report = repaired.report as FuzzReport;
      genAttempts = repaired.attempts;
      genExamples = repaired.examples;
      promptHash = repaired.promptHash ?? promptHash;
    } else {
      report = await fuzzSource(source);
    }
  } finally {
    try {
      unlinkSync(tmpSlim);
    } catch {
      /* gone */
    }
  }

  if (report.disagreements.length) {
    const first = report.disagreements[0]!;
    const msg = usedCatalog
      ? `catalog disagreement (Slim bug, not LLM-patched): ${first.symbol} ${first.reason}`
      : `fuzz disagreements remain: ${first.symbol} ${first.reason}`;
    throw new SlimExit(EXIT_FAIL, msg);
  }

  const txn = new MutationTxn(project.root);
  const fromSpecs = envelopeSpecifiers(env, args.pkg);
  const declared = [
    ...Object.keys(project.packageJson.dependencies ?? {}),
    ...Object.keys(project.packageJson.devDependencies ?? {}),
    ...Object.keys(project.packageJson.optionalDependencies ?? {}),
  ];
  const removeNames = args.keepOriginal ? new Set<string>() : removeDependencyNames(env, declared);
  const pkgType = project.packageJson.type;
  const files = filterSourceFiles(walkSourceFiles(project.root), project.root, {
    include: config.include,
    ignore: config.ignore,
  }).filter((f) => {
    if (f === slimPath || f.endsWith(".tmp.mjs")) return false;
    if (f === outAbs || f.startsWith(outAbs + sep)) return false;
    return true;
  });
  for (const f of files) {
    if (!isSafeToRewrite(project.root, f)) {
      throw new SlimExit(
        EXIT_USAGE,
        `unsafe write: ${relative(project.root, f).replace(/\\/g, "/")} escapes the project or is a special file`,
      );
    }
  }
  const needsCjs = files.some((f) => isCjsConsumer(f, pkgType));
  const cjsPath = needsCjs ? join(outAbs, `${fileBase(env.package.name)}.cjs`) : null;
  const standingTestRel = relative(
    project.root,
    join(outAbs, `${fileBase(env.package.name)}.test.ts`),
  ).replace(/\\/g, "/");
  const moduleRel = relative(project.root, slimPath).replace(/\\/g, "/");
  const cjsRel = cjsPath ? relative(project.root, cjsPath).replace(/\\/g, "/") : null;

  let slimFiles: string[] = [];
  try {
    txn.writeFile(slimPath, source);
    if (cjsPath) {
      txn.writeFile(cjsPath, emitCjsSource(ts, source, cjsPath));
    }
    injectFail("after-slice");

    const changed: string[] = [];
    const rewrites: RevertPlan["rewrites"] = [];
    for (const file of files) {
      const dest = needsCjs && isCjsConsumer(file, pkgType) && cjsPath ? cjsPath : slimPath;
      const rel = toRelativeSpecifier(file, dest);
      const src = readFileSync(file, "utf8");
      const next = spliceSpecifiers(ts, src, file, fromSpecs, rel);
      if (next.changed) {
        txn.writeFile(file, next.text);
        changed.push(file);
        const orig = env.imports.find((i) => join(project.root, i.loc.file) === file)?.specifier;
        rewrites.push({
          file: relative(project.root, file).replace(/\\/g, "/"),
          original: orig ?? env.package.name,
          replacement: rel,
        });
      }
    }
    injectFail("after-rewrites");

    txn.snapshot(project.packageJsonPath);
    if (!args.keepOriginal) {
      let pkgText = readFileSync(project.packageJsonPath, "utf8");
      let removed = false;
      for (const name of removeNames) {
        const next = removeDependencyKey(pkgText, name);
        if (next.removed) {
          pkgText = next.text;
          removed = true;
        }
      }
      if (removed) txn.writeFile(project.packageJsonPath, pkgText);
    }
    const lf = lockfilePath(project.root, project.lockfile);
    if (lf) txn.snapshot(lf);
    if (shouldRefreshLockfile({ keepOriginal: args.keepOriginal, noInstall: args.noInstall })) {
      refreshLockfile(project);
      txn.lockfileRefreshed = true;
    }
    injectFail("after-lockfile");

    const holes = coverageHoles(env);
    const revert: RevertPlan = {
      package: env.package.name,
      version: env.package.version,
      module: moduleRel,
      tests: standingTestRel,
      cjsCompanion: cjsRel,
      rewrites,
      lockfile: project.lockfile,
      installCommand: installCommandFor(project.lockfile),
    };
    const evidenceDir = join(project.root, ".slim", env.package.name);
    txn.prepareWrite(join(evidenceDir, "evidence.md"));
    txn.prepareWrite(join(evidenceDir, "evidence.json"));
    writeEvidence({
      root: project.root,
      env,
      replacementBytes: Buffer.byteLength(source),
      originalMin: originalSize.minBytes,
      moduleSource: source,
      fuzz: {
        cases: report.cases,
        comparisons: report.comparisons,
        timerCases: report.timerCases,
        tracesReplayed: report.tracesReplayed,
        wallMs: report.wallMs,
        seed: report.seed,
        disagreements: report.disagreements.length,
        ...(report.allowFlaky ? { allowFlaky: true } : {}),
      },
      catalogIds,
      coverageHoles: holes,
      revert,
      generation: usedCatalog
        ? {
            kind: "catalog",
            catalogIds,
            attempts: 1,
            specSource: "catalog",
            counterexamples: [],
          }
        : {
            kind: "llm",
            catalogIds: [],
            provider: llm?.kind,
            model: llm?.model,
            promptHash,
            attempts: genAttempts,
            specSource: publicApi?.source ?? "envelope-only",
            limitation: publicApi?.limitation,
            counterexamples: genExamples,
          },
    });
    injectFail("after-evidence");

    const runner = detectRunner(project.root);
    const testRunner = runner.kind === "vitest" ? "vitest" : "node:test";
    const testAbs = join(project.root, standingTestRel);
    txn.prepareWrite(testAbs);
    const modSpec = toRelativeSpecifier(testAbs, slimPath);
    emitStandingTests({
      root: project.root,
      outDir,
      pkg: fileBase(env.package.name),
      env,
      traces: env.traces,
      runner: testRunner,
      moduleSpecifier: modSpec,
    });
    const hardenedAbs = slimPath.replace(/\.(ts|js|mjs|cjs)$/, ".hardened.test.ts");
    txn.prepareWrite(hardenedAbs);
    emitHardenedGetSetTest({
      root: project.root,
      moduleRel: relative(project.root, slimPath),
      runner: testRunner,
    });
    injectFail("after-standing");

    txn.prepareWrite(join(project.root, ".slim", "manifest.json"));
    writeManifest(project.root, env, slimPath);
    txn.prepareWrite(join(project.root, "slim.json"));
    writeSlimJson(project.root, env, slimPath);

    const pkgSlimDir = join(project.root, ".slim", env.package.name);
    txn.prepareWrite(join(pkgSlimDir, "envelope.json"));
    const disk = envelopeForDisk(env);
    assertDocument("envelope", disk);
    writeFileSync(join(pkgSlimDir, "envelope.json"), JSON.stringify(disk, null, 2) + "\n");
    txn.prepareWrite(join(pkgSlimDir, "traces.meta.json"));
    writeTracesMeta(pkgSlimDir);
    injectFail("after-manifest");

    process.stdout.write(
      `wrote ${relative(project.root, slimPath)}  (${replacementBytes} B, hash ${hashEnvelope(env).slice(0, 12)}…)\n`,
    );
    process.stdout.write(`fuzz cases=${report.cases} comparisons=${report.comparisons} timerCases=${report.timerCases}\n`);
    process.stdout.write("EVIDENCE, NOT PROOF — see .slim/" + env.package.name + "/evidence.md\n");
    if (changed.length) process.stdout.write(`rewrote ${changed.length} import files\n`);

    if (shouldRunMergeGate(args)) {
      runMergeGate(project.root, config.testCommand);
    }
    slimFiles = txn.mutatedPaths();
    txn.commit();
  } catch (err) {
    const ranInstall = txn.lockfileRefreshed;
    txn.rollback();
    if (ranInstall) {
      try {
        refreshLockfile(project, { keepOriginal: false, noInstall: false, frozen: true });
      } catch {
        process.stderr.write("lockfile restored; node_modules may need a manual install\n");
      }
    }
    throw err;
  }

  if (!args.noPr) {
    const pr = await maybeCreatePullRequest(!args.noPr, {
      root: project.root,
      title: `slim: replace ${env.package.name} with a verified slice`,
      body: prBodyFromEvidence(project.root, env.package.name),
      branch: `slim/${fileBase(env.package.name)}`,
      files: slimFiles,
      labels: [...REPLACE_PR_LABELS],
      kind: "replace",
      pkg: env.package.name,
    });
    if (pr?.url) process.stdout.write(pr.url + "\n");
  }
  return EXIT_OK;
}

export function shouldRunMergeGate(opts: { dryRun: boolean }): boolean {
  return !opts.dryRun;
}

export function runMergeGate(root: string, testCommand: string | null, json = false): void {
  let cmd = testCommand?.trim() || null;
  if (!cmd) {
    try {
      const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
        scripts?: { test?: string };
      };
      cmd = pkg.scripts?.test?.trim() || null;
    } catch {
      cmd = null;
    }
  }
  if (!cmd) return;
  const parts = cmd.split(/\s+/).filter(Boolean);
  const file = resolveScriptFile(parts[0]!);
  const r = spawnSync(file, parts.slice(1), {
    cwd: root,
    encoding: "utf8",
    stdio: json ? ["ignore", "pipe", "pipe"] : "inherit",
    env: withLocalBinPath(root),
    ...scriptSpawnOpts(file),
  });
  if (json) {
    if (r.stdout) process.stderr.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
  }
  if (r.status !== 0) {
    throw new SlimExit(EXIT_FAIL, `merge gate failed: tests exited ${r.status ?? "signal"}`);
  }
}

const PROTO = "__proto__";
function pathHasProtoSegment(path: SlimValue | undefined): boolean {
  if (!path) return false;
  if (path.t === "str") return path.v.split(/[./]/).includes(PROTO);
  if (path.t === "arr") {
    return path.v.some((el) => {
      if (el.t === "str") return el.v === PROTO || el.v.split(/[./]/).includes(PROTO);
      return pathHasProtoSegment(el);
    });
  }
  return false;
}

export function assertNoPollutionDependence(traces: TraceEvent[]): void {
  for (const t of traces) {
    if (t.symbol !== "get" && t.symbol !== "set") continue;
    if (!pathHasProtoSegment(t.args[1])) continue;
    throw new SlimExit(
      EXIT_FAIL,
      `prototype pollution: traces show ${t.symbol} depending on __proto__ ` +
        `(original returned a polluted object or mutated Object.prototype). ` +
        `Slim replacements are hardened and will not reproduce this. ` +
        `Remove __proto__ paths from runtime usage or do not replace this package.`,
    );
  }
}

function toRelativeSpecifier(fromFile: string, toFile: string): string {
  let rel = relative(dirname(fromFile), toFile).replace(/\\/g, "/");
  if (!rel.startsWith(".")) rel = "./" + rel;
  return rel;
}

function coverageHoles(env: Envelope): string[] {
  const holes: string[] = [];
  for (const s of env.symbols) {
    if (s.exportName === "debounce") {
      const opts = s.callSites.some((c) => (c.argc.max ?? 0) >= 3);
      if (!opts) holes.push("debounce options (maxWait/leading) never observed; taxonomy still run in Slim CI");
      const cancel = s.resultMembers.includes("cancel") || s.callSites.some((c) => c.resultMembers.includes("cancel"));
      if (!cancel) holes.push("debounce.cancel never accessed at call sites");
    }
  }
  if (!env.traces.length) holes.push("zero traces replayed");
  return holes;
}

function writeManifest(root: string, env: Envelope, modulePath: string): void {
  const p = join(root, ".slim", "manifest.json");
  let man: { schemaVersion: 1; replacements: Record<string, unknown> } = {
    schemaVersion: 1,
    replacements: {},
  };
  if (existsSync(p)) {
    try {
      const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<typeof man>;
      man = {
        schemaVersion: 1,
        replacements: raw.replacements && typeof raw.replacements === "object" ? raw.replacements : {},
      };
    } catch {
      /* reset */
    }
  }
  man.replacements[env.package.name] = {
    version: env.package.version,
    envelopeHash: hashEnvelope(env),
    symbols: env.symbols.map((s) => s.exportName),
    module: relative(root, modulePath),
  };
  mkdirSync(dirname(p), { recursive: true });
  assertDocument("manifest", man);
  writeFileSync(p, JSON.stringify(man, null, 2) + "\n");
}

function writeSlimJson(root: string, env: Envelope, modulePath: string): void {
  const p = join(root, "slim.json");
  const cur: {
    outDir?: string;
    replacements: Record<string, { version: string; envelope: string; module: string }>;
  } = existsSync(p)
    ? {
        replacements: {},
        ...(JSON.parse(readFileSync(p, "utf8")) as {
          outDir?: string;
          replacements?: Record<string, { version: string; envelope: string; module: string }>;
        }),
      }
    : { outDir: "src/slim", replacements: {} };
  cur.replacements = cur.replacements ?? {};
  cur.replacements[env.package.name] = {
    version: env.package.version,
    envelope: `.slim/${env.package.name}/envelope.json`,
    module: relative(root, modulePath),
  };
  assertDocument("slim", cur);
  writeFileSync(p, JSON.stringify(cur, null, 2) + "\n");
}

function printDryRun(env: Envelope, source: string, ids: string[]): void {
  process.stdout.write(`dry-run ${env.package.name} symbols=${env.symbols.map((s) => s.exportName).join(",")}\n`);
  process.stdout.write(`catalog ${ids.join(",") || "llm"}\n`);
  if (env.closure.reason.includes("--no-trace")) {
    process.stdout.write("static-only --no-trace (cannot claim trace-closed)\n");
  }
  process.stdout.write(`---\n${source.slice(0, 2000)}\n`);
}
