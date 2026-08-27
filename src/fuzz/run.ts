import { availableParallelism } from "node:os";
import type { Envelope, SymbolEnvelope, TraceEvent } from "../envelope/types.ts";
import { EXIT_ENV, EXIT_FAIL, EXIT_REFUSED, SlimExit } from "../exit.ts";
import { refusePackage } from "../scan/refuse.ts";
import {
  createGen,
  fromTraces,
  mutateArgs,
  fromShapes,
  junkArgs,
  enumerateLiteralUnions,
  isExportTrace,
  pickObservedArgc,
} from "./gen.ts";
import { deserializeEvent } from "../trace/serialize.ts";
import { STARTUP_MS, SHUTDOWN_MS, extraCaseQuota, createFakeClock, nativeClear, nativeTimeout, wallMs, type FakeClock } from "./clock.ts";
import {
  taxonomyForObserved,
  isTimerSymbol,
  TAXONOMY,
  type DebounceScript,
} from "./debounce-driver.ts";
import {
  createPool,
  defaultJobTimeoutMs,
  loadOrig,
  loadSlim,
  runJob,
  withSlimQuery,
  toCloneableResult,
  fromCloneableResult,
  type FuzzJob,
  type FuzzResult,
} from "./workers.ts";
import { symbolMatches } from "../trace/attribute.ts";

const MAX_DISAGREEMENTS = 20;

export interface FuzzReport {
  cases: number;
  comparisons: number;
  timerCases: number;
  disagreements: Array<{
    symbol: string;
    args: unknown[];
    reason: string;
    minimized?: unknown[];
  }>;
  tracesReplayed: number;
  wallMs: number;
  seed: number;
  allowFlaky: boolean;
}

export function defaultWorkerCount(): number {
  try {
    return Math.max(1, availableParallelism() - 1);
  } catch {
    return 1;
  }
}

export function isInjectableCrypto(pkg: string): boolean {
  return pkg === "uuid" || pkg === "nanoid" || pkg.startsWith("uuid/");
}

export async function runFuzz(opts: {
  original?: Record<string, Function>;
  replacement?: Record<string, Function>;
  origModule?: string;
  slimModule?: string;
  slimHash?: string;
  envelope: Envelope;
  budgetMs: number;
  seed: number;
  /** Default: max(1, availableParallelism()-1). Tests that need determinism pass 1. */
  workers?: number;
  allowFlaky?: boolean;
  projectRoot?: string;
}): Promise<FuzzReport> {
  const allowFlaky = opts.allowFlaky === true;
  assertFuzzAllowed(opts.envelope, { allowFlaky });
  const workers = opts.workers ?? defaultWorkerCount();
  if (workers > 1) {
    if (!opts.origModule || !opts.slimModule) {
      throw new Error("workers > 1 requires origModule and slimModule");
    }
    return runFuzzPool({
      ...opts,
      workers,
      allowFlaky,
      origModule: opts.origModule,
      slimModule: opts.slimModule,
    });
  }
  return runFuzzInProcess({ ...opts, allowFlaky });
}

function assertFuzzAllowed(envelope: Envelope, opts: { allowFlaky: boolean }): void {
  const pkg = envelope.package.name;
  if (envelope.cryptoRandom && !opts.allowFlaky && !isInjectableCrypto(pkg)) {
    throw new SlimExit(
      EXIT_REFUSED,
      `refused fuzz: unseeded RNG package ${pkg} without injectable isolation; pass --allow-flaky to override`,
    );
  }
  const returnsNow = envelope.symbols.some((s) => s.exportName === "now");
  if (returnsNow && envelope.clock === false) {
    throw new SlimExit(
      EXIT_REFUSED,
      `refused fuzz: Date.now as a returned value (symbol now) requires clock isolation`,
    );
  }
  const blockerText = [...envelope.slimmable.blockers, ...envelope.slimmable.reasons].join(" ");
  if (/\bnative\b/i.test(blockerText) || /\bnetwork\b/i.test(blockerText)) {
    throw new SlimExit(EXIT_REFUSED, `refused fuzz: network/native package ${pkg}`);
  }
  if (refusePackage(pkg)) {
    throw new SlimExit(EXIT_REFUSED, `refused fuzz: network/native package ${pkg}`);
  }
}

function assertRequiredFunctions(
  original: Record<string, Function>,
  replacement: Record<string, Function>,
  envelope: Envelope,
): void {
  for (const sym of envelope.symbols) {
    if (typeof original[sym.exportName] !== "function") {
      throw new SlimExit(EXIT_FAIL, `missing function ${sym.exportName}`);
    }
    if (typeof replacement[sym.exportName] !== "function") {
      throw new SlimExit(EXIT_FAIL, `missing function ${sym.exportName}`);
    }
  }
}

function cryptoSeedFor(
  envelope: Envelope,
  allowFlaky: boolean,
  seed: number,
  caseIndex: number,
): number | undefined {
  if (allowFlaky) return undefined;
  if (!envelope.cryptoRandom || !isInjectableCrypto(envelope.package.name)) return undefined;
  return (seed + caseIndex) >>> 0;
}

async function runFuzzInProcess(opts: {
  original?: Record<string, Function>;
  replacement?: Record<string, Function>;
  origModule?: string;
  slimModule?: string;
  slimHash?: string;
  envelope: Envelope;
  budgetMs: number;
  seed: number;
  allowFlaky: boolean;
  projectRoot?: string;
}): Promise<FuzzReport> {
  const t0 = wallMs();
  const report = emptyReport(opts.seed, opts.allowFlaky);

  let persistClock: FakeClock | undefined;
  let original = opts.original;
  let replacement = opts.replacement;
  try {
    if (!original && opts.origModule) {
      if (opts.envelope.clock) {
        persistClock = createFakeClock(0);
        persistClock.install();
      }
      original = await loadOrig(opts.origModule, opts.projectRoot);
    }
    if (!replacement && opts.slimModule) {
      replacement = await loadSlim(withSlimQuery(opts.slimModule, opts.slimHash));
    }
    if (!original || !replacement) {
      throw new Error("runFuzz requires original/replacement or origModule/slimModule");
    }
    assertRequiredFunctions(original, replacement, opts.envelope);

    const plan = planCases(opts);
    for (const item of plan) {
      if (report.disagreements.length >= MAX_DISAGREEMENTS) break;
      const r = await runJob(original, replacement, item.job, persistClock);
      applyPlanned(report, item, r);
    }
    throwIfEmpty(report);
  } finally {
    persistClock?.uninstall();
  }

  report.wallMs = wallMs() - t0;
  return freezeReport(report);
}

async function runFuzzPool(opts: {
  origModule: string;
  slimModule: string;
  slimHash?: string;
  envelope: Envelope;
  budgetMs: number;
  seed: number;
  workers: number;
  allowFlaky: boolean;
  projectRoot?: string;
}): Promise<FuzzReport> {
  const t0 = wallMs();
  const report = emptyReport(opts.seed, opts.allowFlaky);
  const symbols = opts.envelope.symbols.map((s) => s.exportName);

  const timeoutMs = defaultJobTimeoutMs(opts.budgetMs);
  const pool = createPool({
    workers: opts.workers,
    origModule: opts.origModule,
    slimModule: opts.slimModule,
    symbols,
    clock: opts.envelope.clock,
    slimHash: opts.slimHash,
    projectRoot: opts.projectRoot,
    timeoutMs,
  });

  try {
    await pool.ready();
    const plan = planCases(opts);
    const bound = t0 + Math.max(0, opts.budgetMs) + STARTUP_MS + SHUTDOWN_MS;
    await executePlanOnPool(pool, plan, report, opts.workers, timeoutMs, bound);
    throwIfEmpty(report);
  } finally {
    await pool.close();
  }

  report.wallMs = wallMs() - t0;
  return freezeReport(report);
}

interface PlannedCase {
  seq: number;
  job: FuzzJob;
  isTrace: boolean;
  isDebounce: boolean;
  script?: DebounceScript;
}

function planCases(opts: {
  envelope: Envelope;
  seed: number;
  budgetMs: number;
  allowFlaky: boolean;
}): PlannedCase[] {
  const gen = createGen(opts.seed);
  const out: PlannedCase[] = [];
  let seq = 0;
  const add = (
    job: FuzzJob,
    extra: { isTrace?: boolean; isDebounce?: boolean; script?: DebounceScript } = {},
  ): void => {
    const id = seq++;
    out.push({
      seq: id,
      job: {
        ...job,
        cryptoSeed: cryptoSeedFor(opts.envelope, opts.allowFlaky, opts.seed, id),
      },
      isTrace: extra.isTrace === true,
      isDebounce: extra.isDebounce === true,
      script: extra.script,
    });
  };

  const timerSymbols = opts.envelope.symbols.filter((s) => isTimerSymbol(s.exportName));
  const valueSymbols = opts.envelope.symbols.filter((s) => !isTimerSymbol(s.exportName));

  for (const sym of timerSymbols) {
    for (const script of scriptsForSymbol(sym, opts.envelope)) {
      add(
        { symbol: sym.exportName, args: [script], kind: "debounce", script, hyrum: sym.hyrum },
        { isDebounce: true, script },
      );
    }
  }

  let extraLeft = extraCaseQuota(opts.budgetMs);
  for (const sym of valueSymbols) {
    const traces = exportTracesFor(opts.envelope, sym);
    const hyrum = sym.hyrum;
    for (const tr of traces) {
      const live = deserializeEvent({ args: tr.args, thisArg: tr.thisArg, result: tr.result });
      add(
        { symbol: sym.exportName, args: live.args, thisArg: live.thisArg, kind: "call", hyrum },
        { isTrace: true },
      );
    }
    for (const site of sym.callSites) {
      const arities = site.argc.observed.length ? site.argc.observed : [site.argShapes.length];
      for (const argc of arities) {
        const sliced = site.argShapes.slice(0, argc);
        for (const args of enumerateLiteralUnions(sliced, 64)) {
          add({ symbol: sym.exportName, args, kind: "call", hyrum });
        }
      }
    }
    const replayed = fromTraces(traces, gen);
    while (extraLeft > 0) {
      extraLeft--;
      add({ symbol: sym.exportName, args: pickFuzzArgs(gen, replayed, sym), kind: "call", hyrum });
    }
  }
  return out;
}

function applyPlanned(report: FuzzReport, item: PlannedCase, r: FuzzResult): void {
  const wired = fromCloneableResult(toCloneableResult(r));
  if (item.isDebounce) {
    recordPoolDebounce(report, wired, item.script!);
    return;
  }
  recordPoolCall(report, wired);
  if (item.isTrace) report.tracesReplayed++;
}

function freezeReport(report: FuzzReport): FuzzReport {
  Object.freeze(report.disagreements);
  return Object.freeze(report);
}

function throwIfEmpty(report: FuzzReport): void {
  if (report.cases === 0) {
    throw new SlimExit(EXIT_ENV, "insufficient budget");
  }
}

async function executePlanOnPool(
  pool: { runCase(job: FuzzJob, timeoutMs?: number): Promise<FuzzResult> },
  plan: PlannedCase[],
  report: FuzzReport,
  workers: number,
  timeoutMs: number,
  bound: number,
): Promise<void> {
  const slots = new Map<number, { result?: FuzzResult; error?: unknown }>();
  const running = new Map<number, Promise<void>>();
  let applyAt = 0;
  let issued = 0;
  const width = Math.max(1, workers);

  const start = (seq: number, item: PlannedCase): void => {
    const p = pool
      .runCase(item.job, timeoutMs)
      .then(
        (result) => {
          slots.set(seq, { result });
        },
        (error: unknown) => {
          slots.set(seq, { error });
        },
      )
      .finally(() => {
        running.delete(seq);
      });
    running.set(seq, p);
  };

  while (applyAt < plan.length && report.disagreements.length < MAX_DISAGREEMENTS) {
    if (wallMs() >= bound) throw new SlimExit(EXIT_ENV, "fuzz worker timeout");
    while (
      issued < plan.length &&
      running.size < width &&
      report.disagreements.length < MAX_DISAGREEMENTS
    ) {
      start(issued, plan[issued]!);
      issued++;
    }
    if (!slots.has(applyAt)) {
      if (running.size === 0) break;
      const rem = Math.max(1, bound - wallMs());
      let timer: ReturnType<typeof nativeTimeout> | undefined;
      try {
        await Promise.race([
          Promise.race([...running.values()]),
          new Promise<never>((_, reject) => {
            timer = nativeTimeout(() => reject(new SlimExit(EXIT_ENV, "fuzz worker timeout")), rem);
          }),
        ]);
      } finally {
        if (timer) nativeClear(timer);
      }
      continue;
    }
    const slot = slots.get(applyAt)!;
    if (slot.error) throw slot.error;
    applyPlanned(report, plan[applyAt]!, slot.result!);
    applyAt++;
  }

  await Promise.all([...running.values()]);
}

function emptyReport(seed: number, allowFlaky: boolean): FuzzReport {
  return {
    cases: 0,
    comparisons: 0,
    timerCases: 0,
    disagreements: [],
    tracesReplayed: 0,
    wallMs: 0,
    seed,
    allowFlaky,
  };
}

function recordPoolCall(report: FuzzReport, r: FuzzResult): void {
  if (r.reason?.startsWith("missing function")) {
    throw new SlimExit(EXIT_FAIL, r.reason);
  }
  report.cases++;
  report.comparisons++;
  if (r.ok) return;
  if (report.disagreements.length < MAX_DISAGREEMENTS) {
    report.disagreements.push({
      symbol: r.symbol,
      args: r.args ?? [],
      reason: r.reason ?? "mismatch",
      minimized: r.minimized,
    });
  }
}

function recordPoolDebounce(report: FuzzReport, r: FuzzResult, script: DebounceScript): void {
  if (r.reason?.startsWith("missing function")) {
    throw new SlimExit(EXIT_FAIL, r.reason);
  }
  report.cases++;
  report.timerCases++;
  report.comparisons += 3;
  if (r.ok) return;
  if (report.disagreements.length < MAX_DISAGREEMENTS) {
    report.disagreements.push({
      symbol: r.symbol,
      args: [script],
      reason: r.reason ?? "mismatch",
    });
  }
}

export function traceHits(tr: TraceEvent, sym: SymbolEnvelope): boolean {
  if (symbolMatches(sym.exportName, tr.symbol)) return true;
  const path = sym.callSites[0]?.memberPath?.join(".");
  if (path === undefined) return false;
  return tr.symbol === path || symbolMatches(path, tr.symbol);
}

function closedArgShapes(sym: SymbolEnvelope): boolean {
  if (!sym.callSites.length) return false;
  return sym.callSites.every(
    (c) =>
      c.argShapes.length > 0 &&
      c.argShapes.every((s) => s.kind === "literal" || s.kind === "date" || s.kind === "union"),
  );
}

function pickFuzzArgs(gen: ReturnType<typeof createGen>, replayed: unknown[][], sym: SymbolEnvelope): unknown[] {
  const closed =
    closedArgShapes(sym) ||
    (replayed.length > 0 &&
      replayed.every((args) =>
        args.every((a) => a instanceof Date || typeof a === "string" || typeof a === "number"),
      ));
  const r = gen.next();
  if (replayed.length && (closed || r < 0.7)) {
    const base = gen.pick(replayed);
    if (!closed && r < 0.35) return mutateArgs(base, gen);
    return base.slice() as unknown[];
  }
  if (sym.callSites.length && r < 0.9) {
    const site = gen.pick(sym.callSites);
    const argc = pickObservedArgc(site.argc.observed, gen, site.argShapes.length || 2);
    return fromShapes(site.argShapes, gen, argc);
  }
  const argc = pickObservedArgc(
    sym.callSites.flatMap((c) => c.argc.observed),
    gen,
    2,
  );
  return junkArgs(argc, gen);
}

function exportTracesFor(envelope: Envelope, sym: SymbolEnvelope): TraceEvent[] {
  return envelope.traces.filter((tr) => traceHits(tr, sym) && isExportTrace(tr));
}

function scriptsForSymbol(sym: SymbolEnvelope, envelope: Envelope): DebounceScript[] {
  const observedArgcList = sym.callSites.flatMap((c) => c.argc.observed);
  const optionLiterals: unknown[] = [];
  for (const c of sym.callSites) {
    const opt = c.argShapes[2];
    if (opt?.literals) optionLiterals.push(...opt.literals);
  }
  const selected = taxonomyForObserved({
    exportName: sym.exportName,
    observedArgc: observedArgcList,
    optionLiterals,
    full: Boolean(process.env.CI),
  });
  if (selected.length) return selected;
  if (envelope.clock || isTimerSymbol(sym.exportName)) {
    return Object.values(TAXONOMY);
  }
  return [];
}

export { isExportTrace };
