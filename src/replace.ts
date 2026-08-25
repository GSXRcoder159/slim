import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { randomInt } from "node:crypto";
import type { CliArgs } from "./cli.ts";
import { EXIT_FAIL, EXIT_OK, EXIT_REFUSED, EXIT_USAGE, SlimExit } from "./exit.ts";
import { loadConfig } from "./config.ts";
import { loadProject, walkSourceFiles, filterSourceFiles } from "./project.ts";
import { analyzePackage } from "./analyze/index.ts";
import { closeEnvelope } from "./envelope/close.ts";
import { hashEnvelope } from "./envelope/hash.ts";
import { envelopeForDisk } from "./envelope/types.ts";
import type { Envelope, SlimValue, TraceEvent } from "./envelope/types.ts";
import { refusePackage, formatRefuse } from "./scan/refuse.ts";
import { estimatePackageSize } from "./size/estimate.ts";
import { matchCatalog } from "./generate/catalog/index.ts";
import { catalogBoundary } from "./generate/catalog/boundary.ts";
import { assembleCatalogModule } from "./generate/assemble.ts";
import { withGeneratedHeader } from "./generate/header.ts";
import { llmConfigFromEnv, generateWithLlm } from "./generate/llm.ts";
import { assertValidGenerated, assertSmaller } from "./generate/validate.ts";
import { loadPublicApi } from "./generate/public-api.ts";
import { loadTargetTypescript } from "./project.ts";
import { runFuzz, type FuzzReport } from "./fuzz/run.ts";
import { repairLoop } from "./generate/repair.ts";
import { rewriteProjectImports } from "./rewrite/splice.ts";
import { rewritePackageJson } from "./rewrite/packagejson.ts";
import { refreshLockfile, shouldRefreshLockfile } from "./rewrite/lockfile.ts";
import { writeEvidence } from "./evidence/report.ts";
import { emitStandingTests } from "./evidence/emit-tests.ts";
import { maybeCreatePullRequest, prBodyFromEvidence } from "./github/pr.ts";
import { detectRunner } from "./trace/runners.ts";
import { runTraces, withLocalBinPath, writeTracesMeta } from "./trace/run.ts";

export { withLocalBinPath, writeTracesMeta };

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
    env = runTraces(project.root, args.pkg, env);
    env = closeEnvelope(env, { allowUnknown: args.allowUnknown });
  } else {
    env = closeEnvelope(env, { allowUnknown: args.allowUnknown });
  }
  assertNoPollutionDependence(env.traces);

  if (env.slimmable.verdict === "refuse" && !args.force) {
    throw new SlimExit(
      EXIT_REFUSED,
      `refused ${args.pkg}: ${env.slimmable.blockers.join("; ") || env.closure.reason}`,
    );
  }
  if (!env.closure.readyToGenerate && !args.allowUnknown && !args.force) {
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
      `no catalog for ${catalog.missing.join(", ") || args.pkg} and no LLM key (set ANTHROPIC_API_KEY or OPENAI_API_KEY)`,
    );
  } else if (!llm) {
    throw new SlimExit(EXIT_REFUSED, "LLM requested but no API key");
  } else {
    process.stderr.write("generating with LLM (clean-room)…\n");
    const pub = loadPublicApi(project.root, env.package.name);
    const gen = await generateWithLlm(env, pub, [], llm);
    source = withGeneratedHeader(gen.source, env, { promptHash: gen.promptHash });
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
  const slimPath = join(project.root, outDir, `${fileBase(env.package.name)}.ts`);

  if (args.dryRun) {
    printDryRun(env, source, catalogIds);
    return EXIT_OK;
  }

  mkdirSync(dirname(slimPath), { recursive: true });
  const transpile = (src: string) =>
    ts.transpileModule(src, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
      },
      fileName: slimPath,
    }).outputText;
  const tmpSlim = slimPath + ".tmp.mjs";
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
  if (!usedCatalog && llm) {
    const pub = loadPublicApi(project.root, env.package.name);
    const repaired = await repairLoop({
      envelope: env,
      publicApi: pub,
      initial: source,
      maxAttempts: args.maxAttempts,
      llm,
      projectRoot: project.root,
      catalog: false,
      fuzz: (src) => fuzzSource(src),
    });
    source = repaired.source;
    report = repaired.report as FuzzReport;
  } else {
    report = await fuzzSource(source);
  }

  if (report.disagreements.length) {
    const first = report.disagreements[0]!;
    const msg = usedCatalog
      ? `catalog disagreement (Slim bug, not LLM-patched): ${first.symbol} ${first.reason}`
      : `fuzz disagreements remain: ${first.symbol} ${first.reason}`;
    throw new SlimExit(EXIT_FAIL, msg);
  }

  writeFileSync(slimPath, source);
  try {
    const { unlinkSync } = await import("node:fs");
    unlinkSync(tmpSlim);
  } catch {
    /* keep */
  }

  const fromSpecs = new Set(env.imports.map((i) => i.specifier));
  fromSpecs.add(args.pkg);
  fromSpecs.add(env.package.name);
  if (env.package.family === "lodash") {
    fromSpecs.add("lodash");
    fromSpecs.add("lodash-es");
  }
  const outAbs = resolve(project.root, outDir);
  const files = filterSourceFiles(walkSourceFiles(project.root), project.root, {
    include: config.include,
    ignore: config.ignore,
  }).filter((f) => {
    if (f === slimPath || f.endsWith(".tmp.mjs")) return false;
    if (f === outAbs || f.startsWith(outAbs + sep)) return false;
    return true;
  });
  const changed: string[] = [];
  for (const file of files) {
    const rel = toRelativeSpecifier(file, slimPath);
    const did = rewriteProjectImports(project.root, [file], fromSpecs, rel);
    changed.push(...did);
  }

  if (!args.keepOriginal) {
    rewritePackageJson(project.packageJsonPath, env.package.name);
    if (env.package.family === "lodash" && env.package.name !== "lodash-es") {
      rewritePackageJson(project.packageJsonPath, "lodash-es");
    }
  }
  if (shouldRefreshLockfile({ keepOriginal: args.keepOriginal, noInstall: args.noInstall })) {
    refreshLockfile(project);
  }

  const holes = coverageHoles(env);
  writeEvidence({
    root: project.root,
    env,
    replacementBytes: Buffer.byteLength(source),
    originalMin: originalSize.minBytes,
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
  });

  const runner = detectRunner(project.root);
  const testRunner = runner.kind === "vitest" ? "vitest" : "node:test";
  const modSpec = toRelativeSpecifier(
    join(project.root, outDir, `${fileBase(env.package.name)}.test.ts`),
    slimPath,
  );
  emitStandingTests({
    root: project.root,
    outDir,
    pkg: fileBase(env.package.name),
    env,
    traces: env.traces,
    runner: testRunner,
    moduleSpecifier: modSpec,
  });

  writeManifest(project.root, env, slimPath);
  writeSlimJson(project.root, env, slimPath);

  const pkgSlimDir = join(project.root, ".slim", env.package.name);
  mkdirSync(pkgSlimDir, { recursive: true });
  writeFileSync(join(pkgSlimDir, "envelope.json"), JSON.stringify(envelopeForDisk(env), null, 2) + "\n");
  writeTracesMeta(pkgSlimDir);

  process.stdout.write(
    `wrote ${relative(project.root, slimPath)}  (${replacementBytes} B, hash ${hashEnvelope(env).slice(0, 12)}…)\n`,
  );
  process.stdout.write(`fuzz cases=${report.cases} comparisons=${report.comparisons} timerCases=${report.timerCases}\n`);
  process.stdout.write("EVIDENCE, NOT PROOF — see .slim/" + env.package.name + "/evidence.md\n");
  if (changed.length) process.stdout.write(`rewrote ${changed.length} import files\n`);

  if (shouldRunMergeGate(args)) {
    runMergeGate(project.root, config.testCommand);
  }

  if (!args.noPr) {
    const pr = await maybeCreatePullRequest(!args.noPr, {
      root: project.root,
      title: `slim: replace ${env.package.name} with a verified slice`,
      body: prBodyFromEvidence(project.root, env.package.name),
      branch: `slim/${fileBase(env.package.name)}`,
    });
    if (pr?.url) process.stdout.write(pr.url + "\n");
  }
  return EXIT_OK;
}

export function shouldRunMergeGate(opts: { dryRun: boolean }): boolean {
  return !opts.dryRun;
}

export function runMergeGate(root: string, testCommand: string | null): void {
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
  const r = spawnSync(parts[0]!, parts.slice(1), {
    cwd: root,
    encoding: "utf8",
    stdio: "inherit",
    env: withLocalBinPath(root),
  });
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

function fileBase(name: string): string {
  return name.replace(/^@/, "").replace(/\//g, "-");
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
  let man: { replacements: Record<string, unknown> } = { replacements: {} };
  if (existsSync(p)) {
    try {
      man = JSON.parse(readFileSync(p, "utf8")) as typeof man;
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
  writeFileSync(p, JSON.stringify(cur, null, 2) + "\n");
}

function printDryRun(env: Envelope, source: string, ids: string[]): void {
  process.stdout.write(`dry-run ${env.package.name} symbols=${env.symbols.map((s) => s.exportName).join(",")}\n`);
  process.stdout.write(`catalog ${ids.join(",") || "llm"}\n`);
  process.stdout.write(`---\n${source.slice(0, 2000)}\n`);
}
