import { availableParallelism } from "node:os";
import type { Envelope, HyrumFlags, SymbolEnvelope, TraceEvent } from "../envelope/types.ts";
import { EXIT_ENV, EXIT_FAIL, EXIT_REFUSED, SlimExit } from "../exit.ts";
import { refusePackage } from "../scan/refuse.ts";
import { equal } from "./equal.ts";
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
import { BUDGET_SLACK_MS, createFakeClock, nativeClear, nativeTimeout, wallMs, type FakeClock } from "./clock.ts";
import {
  runDebounceScript,
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
  const deadline = t0 + Math.max(0, opts.budgetMs);
  const gen = createGen(opts.seed);
  const report = emptyReport(opts.seed, opts.allowFlaky);
  const over = (): boolean => wallMs() >= deadline;

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

    const timerSymbols = opts.envelope.symbols.filter((s) => isTimerSymbol(s.exportName));
    const valueSymbols = opts.envelope.symbols.filter((s) => !isTimerSymbol(s.exportName));

    for (const sym of timerSymbols) {
      const origFn = original[sym.exportName]!;
      const slimFn = replacement[sym.exportName]!;
      const hyrum = sym.hyrum;
      const scripts = scriptsForSymbol(sym, opts.envelope);
      for (const script of scripts) {
        if (report.disagreements.length >= MAX_DISAGREEMENTS) break;
        await recordDebounce(report, origFn, slimFn, sym.exportName, script, hyrum, persistClock);
      }
    }

    for (const sym of valueSymbols) {
      if (report.disagreements.length >= MAX_DISAGREEMENTS) break;
      const origFn = original[sym.exportName]!;
      const slimFn = replacement[sym.exportName]!;
      const traces = exportTracesFor(opts.envelope, sym);
      const hyrum = sym.hyrum;

      for (const tr of traces) {
        if (report.disagreements.length >= MAX_DISAGREEMENTS) break;
        const live = deserializeEvent({ args: tr.args, thisArg: tr.thisArg, result: tr.result });
        await recordCall(report, origFn, slimFn, sym.exportName, live.args, live.thisArg, hyrum, opts, persistClock);
        report.tracesReplayed++;
      }

      for (const site of sym.callSites) {
        if (report.disagreements.length >= MAX_DISAGREEMENTS) break;
        const arities = site.argc.observed.length ? site.argc.observed : [site.argShapes.length];
        for (const argc of arities) {
          const sliced = site.argShapes.slice(0, argc);
          const literals = enumerateLiteralUnions(sliced, 64);
          for (const args of literals) {
            if (report.disagreements.length >= MAX_DISAGREEMENTS) break;
            await recordCall(report, origFn, slimFn, sym.exportName, args, undefined, hyrum, opts, persistClock);
          }
        }
      }

      const replayed = fromTraces(traces, gen);
      while (!over() && report.disagreements.length < MAX_DISAGREEMENTS) {
        const args = pickFuzzArgs(gen, replayed, sym);
        await recordCall(report, origFn, slimFn, sym.exportName, args, undefined, hyrum, opts, persistClock);
      }
    }
  } finally {
    persistClock?.uninstall();
  }

  report.wallMs = wallMs() - t0;
  return report;
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
  const deadline = t0 + Math.max(0, opts.budgetMs);
  const gen = createGen(opts.seed);
  const report = emptyReport(opts.seed, opts.allowFlaky);
  const over = (): boolean => wallMs() >= deadline;
  const symbols = opts.envelope.symbols.map((s) => s.exportName);

  const origFns = await loadOrig(opts.origModule, opts.projectRoot);
  const slimFns = await loadSlim(withSlimQuery(opts.slimModule, opts.slimHash));
  assertRequiredFunctions(origFns, slimFns, opts.envelope);

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
    const timerSymbols = opts.envelope.symbols.filter((s) => isTimerSymbol(s.exportName));
    const valueSymbols = opts.envelope.symbols.filter((s) => !isTimerSymbol(s.exportName));
    const pending = new Set<Promise<void>>();
    const atCap = (): boolean => report.disagreements.length >= MAX_DISAGREEMENTS;

    const racePending = async (): Promise<void> => {
      if (pending.size === 0) return;
      const rem = Math.max(1, deadline + BUDGET_SLACK_MS - wallMs());
      let timer: ReturnType<typeof nativeTimeout> | undefined;
      try {
        await Promise.race([
          ...pending,
          new Promise<never>((_, reject) => {
            timer = nativeTimeout(
              () => reject(new SlimExit(EXIT_ENV, "fuzz worker timeout")),
              rem,
            );
          }),
        ]);
      } finally {
        if (timer) nativeClear(timer);
      }
    };

    const spawn = async (
      job: FuzzJob,
      onResult: (r: FuzzResult) => void,
      untilDeadline = false,
    ): Promise<void> => {
      while (report.disagreements.length + pending.size >= MAX_DISAGREEMENTS && pending.size > 0) {
        await racePending();
      }
      if (atCap()) return;
      if (untilDeadline && over() && report.cases > 0) return;
      const jobMs = untilDeadline
        ? Math.min(timeoutMs, Math.max(50, deadline - wallMs() + 50))
        : timeoutMs;
      const p = pool
        .runCase(job, jobMs)
        .then(onResult)
        .finally(() => pending.delete(p));
      pending.add(p);
      if (pending.size >= opts.workers) await racePending();
    };

    for (const sym of timerSymbols) {
      const scripts = scriptsForSymbol(sym, opts.envelope);
      for (const script of scripts) {
        if (atCap()) break;
        await spawn(
          { symbol: sym.exportName, args: [script], kind: "debounce", script, hyrum: sym.hyrum },
          (r) => recordPoolDebounce(report, r, script),
        );
      }
    }
    await racePending();

    for (const sym of valueSymbols) {
      if (atCap()) break;
      const traces = exportTracesFor(opts.envelope, sym);
      const hyrum = sym.hyrum;

      for (const tr of traces) {
        if (atCap()) break;
        const live = deserializeEvent({ args: tr.args, thisArg: tr.thisArg, result: tr.result });
        await spawn(
          {
            symbol: sym.exportName,
            args: live.args,
            thisArg: live.thisArg,
            kind: "call",
            hyrum,
            cryptoSeed: cryptoSeedFor(opts.envelope, opts.allowFlaky, opts.seed, report.cases),
          },
          (r) => {
            recordPoolCall(report, r);
            report.tracesReplayed++;
          },
        );
      }

      for (const site of sym.callSites) {
        if (atCap()) break;
        const arities = site.argc.observed.length ? site.argc.observed : [site.argShapes.length];
        for (const argc of arities) {
          const sliced = site.argShapes.slice(0, argc);
          const literals = enumerateLiteralUnions(sliced, 64);
          for (const args of literals) {
            if (atCap()) break;
            await spawn(
              {
                symbol: sym.exportName,
                args,
                kind: "call",
                hyrum,
                cryptoSeed: cryptoSeedFor(opts.envelope, opts.allowFlaky, opts.seed, report.cases),
              },
              (r) => recordPoolCall(report, r),
            );
          }
        }
      }

      const replayed = fromTraces(traces, gen);
      while (!over() && !atCap()) {
        const args = pickFuzzArgs(gen, replayed, sym);
        await spawn(
          {
            symbol: sym.exportName,
            args,
            kind: "call",
            hyrum,
            cryptoSeed: cryptoSeedFor(opts.envelope, opts.allowFlaky, opts.seed, report.cases),
          },
          (res) => recordPoolCall(report, res),
          true,
        );
      }
    }
    await racePending();
    if (pending.size) await Promise.all(pending);
  } finally {
    await pool.close();
  }

  report.wallMs = wallMs() - t0;
  return report;
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

async function recordCall(
  report: FuzzReport,
  origFn: Function,
  slimFn: Function,
  symbol: string,
  args: unknown[],
  thisArg: unknown,
  hyrum: Partial<HyrumFlags> | undefined,
  opts: { envelope: Envelope; allowFlaky: boolean; seed: number },
  persistClock?: FakeClock,
): Promise<void> {
  const r = await runJob(
    { [symbol]: origFn },
    { [symbol]: slimFn },
    {
      symbol,
      args,
      thisArg,
      kind: "call",
      hyrum,
      cryptoSeed: cryptoSeedFor(opts.envelope, opts.allowFlaky, opts.seed, report.cases),
    },
    persistClock,
  );
  recordPoolCall(report, r);
}

async function recordDebounce(
  report: FuzzReport,
  origFn: Function,
  slimFn: Function,
  symbol: string,
  script: DebounceScript,
  hyrum: Partial<HyrumFlags> | undefined,
  persistClock?: FakeClock,
): Promise<void> {
  let a;
  let b;
  if (persistClock) {
    persistClock.reset(0);
    a = await runDebounceScript(origFn, script, persistClock);
    persistClock.reset(0);
    b = await runDebounceScript(slimFn, script, persistClock);
  } else {
    const clockOrig = createFakeClock(0);
    const clockSlim = createFakeClock(0);
    a = await runDebounceScript(origFn, script, clockOrig);
    b = await runDebounceScript(slimFn, script, clockSlim);
  }
  report.cases++;
  report.timerCases++;
  report.comparisons += 3;
  const spiesOk = equal(a.spies, b.spies, hyrum);
  const retOk = equal(a.returns, b.returns, hyrum);
  const flushOk = equal(a.flushResults, b.flushResults, hyrum);
  if (spiesOk && retOk && flushOk) return;
  report.disagreements.push({
    symbol,
    args: [script],
    reason: !spiesOk ? "debounce spy timeline mismatch" : "debounce return/flush mismatch",
  });
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
