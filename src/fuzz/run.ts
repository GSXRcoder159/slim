import { availableParallelism } from "node:os";
import type { ArgShape, Envelope, HyrumFlags, SymbolEnvelope, TraceEvent } from "../envelope/types.ts";
import { EXIT_REFUSED, SlimExit } from "../exit.ts";
import { refusePackage } from "../scan/refuse.ts";
import { invoke, equalResults, equal } from "./equal.ts";
import { createGen, fromTraces, mutateArgs, fromShapes, junkArgs, enumerateLiteralUnions, hydrate } from "./gen.ts";
import { minimize } from "./minimize.ts";
import { createFakeClock, type FakeClock } from "./clock.ts";
import {
  runDebounceScript,
  taxonomyForObserved,
  isTimerSymbol,
  TAXONOMY,
  type DebounceScript,
} from "./debounce-driver.ts";
import { createPool, loadOrig, loadSlim, withSlimQuery, type FuzzJob, type FuzzResult } from "./workers.ts";

const MAX_DISAGREEMENTS = 20;
const MINIMIZE_MS = 2000;

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
}

export function defaultWorkerCount(): number {
  try {
    return Math.max(1, availableParallelism() - 1);
  } catch {
    return 1;
  }
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
}): Promise<FuzzReport> {
  assertFuzzAllowed(opts.envelope, { allowFlaky: opts.allowFlaky === true });
  const workers = opts.workers ?? defaultWorkerCount();
  if (workers > 1) {
    if (!opts.origModule || !opts.slimModule) {
      throw new Error("workers > 1 requires origModule and slimModule");
    }
    return runFuzzPool({
      ...opts,
      workers,
      origModule: opts.origModule,
      slimModule: opts.slimModule,
    });
  }
  return runFuzzInProcess(opts);
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

function isInjectableCrypto(pkg: string): boolean {
  return pkg === "uuid" || pkg === "nanoid" || pkg.startsWith("uuid/");
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
}): Promise<FuzzReport> {
  const t0 = Date.now();
  const deadline = t0 + Math.max(0, opts.budgetMs);
  const gen = createGen(opts.seed);
  const report = emptyReport(opts.seed);

  let persistClock: FakeClock | undefined;
  let original = opts.original;
  let replacement = opts.replacement;
  try {
    if (!original && opts.origModule) {
      if (opts.envelope.clock) {
        persistClock = createFakeClock(0);
        persistClock.install();
      }
      original = await loadOrig(opts.origModule);
    }
    if (!replacement && opts.slimModule) {
      replacement = await loadSlim(withSlimQuery(opts.slimModule, opts.slimHash));
    }
    if (!original || !replacement) {
      throw new Error("runFuzz requires original/replacement or origModule/slimModule");
    }

    const timerSymbols = opts.envelope.symbols.filter((s) => isTimerSymbol(s.exportName));
    const valueSymbols = opts.envelope.symbols.filter((s) => !isTimerSymbol(s.exportName));

    for (const sym of timerSymbols) {
      const origFn = original[sym.exportName];
      const slimFn = replacement[sym.exportName];
      if (typeof origFn !== "function" || typeof slimFn !== "function") continue;
      const hyrum = sym.hyrum;
      const scripts = scriptsForSymbol(sym, opts.envelope);
      for (const script of scripts) {
        await recordDebounce(report, origFn, slimFn, sym.exportName, script, hyrum, persistClock);
        if (report.disagreements.length >= MAX_DISAGREEMENTS) break;
      }
    }

    for (const sym of valueSymbols) {
      if (Date.now() >= deadline && report.cases > 0) break;
      if (report.disagreements.length >= MAX_DISAGREEMENTS) break;
      const origFn = original[sym.exportName];
      const slimFn = replacement[sym.exportName];
      if (typeof origFn !== "function" || typeof slimFn !== "function") continue;

      const traces = opts.envelope.traces.filter((tr) => traceHits(tr, sym));
      const hyrum = sym.hyrum;

      for (const tr of traces) {
        const args = tr.args.map((a) => hydrate(a));
        const thisArg = tr.thisArg ? hydrate(tr.thisArg) : undefined;
        recordCall(report, origFn, slimFn, sym.exportName, args, thisArg, hyrum, deadline);
        report.tracesReplayed++;
        if (report.disagreements.length >= MAX_DISAGREEMENTS) break;
      }

      const shapes = primaryShapes(sym);
      const literals = enumerateLiteralUnions(shapes, 64);
      for (const args of literals) {
        if (Date.now() >= deadline) break;
        recordCall(report, origFn, slimFn, sym.exportName, args, undefined, hyrum, deadline);
        if (report.disagreements.length >= MAX_DISAGREEMENTS) break;
      }

      const replayed = fromTraces(traces, gen);
      while (Date.now() < deadline && report.disagreements.length < MAX_DISAGREEMENTS) {
        const r = gen.next();
        let args: unknown[];
        if (r < 0.7 && replayed.length) {
          const base = gen.pick(replayed);
          args = r < 0.35 ? (base.slice() as unknown[]) : mutateArgs(base, gen);
        } else if (r < 0.9 && shapes.length) {
          args = fromShapes(shapes, gen);
        } else {
          const argc = observedArgc(sym) || 2;
          args = junkArgs(argc, gen);
        }
        recordCall(report, origFn, slimFn, sym.exportName, args, undefined, hyrum, deadline);
      }
    }
  } finally {
    persistClock?.uninstall();
  }

  report.wallMs = Date.now() - t0;
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
}): Promise<FuzzReport> {
  const t0 = Date.now();
  const deadline = t0 + Math.max(0, opts.budgetMs);
  const gen = createGen(opts.seed);
  const report = emptyReport(opts.seed);
  const symbols = opts.envelope.symbols.map((s) => s.exportName);
  const pool = createPool({
    workers: opts.workers,
    origModule: opts.origModule,
    slimModule: opts.slimModule,
    symbols,
    clock: opts.envelope.clock,
    slimHash: opts.slimHash,
  });

  try {
    const timerSymbols = opts.envelope.symbols.filter((s) => isTimerSymbol(s.exportName));
    const valueSymbols = opts.envelope.symbols.filter((s) => !isTimerSymbol(s.exportName));
    const pending = new Set<Promise<void>>();
    const atCap = (): boolean => report.disagreements.length >= MAX_DISAGREEMENTS;

    const spawn = async (job: FuzzJob, onResult: (r: FuzzResult) => void): Promise<void> => {
      while (report.disagreements.length + pending.size >= MAX_DISAGREEMENTS && pending.size > 0) {
        await Promise.race(pending);
      }
      if (atCap()) return;
      const p = pool.runCase(job).then(onResult).finally(() => pending.delete(p));
      pending.add(p);
      if (pending.size >= opts.workers) await Promise.race(pending);
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
    await Promise.all(pending);

    for (const sym of valueSymbols) {
      if (Date.now() >= deadline && report.cases > 0) break;
      if (atCap()) break;
      const traces = opts.envelope.traces.filter((tr) => traceHits(tr, sym));
      const hyrum = sym.hyrum;

      for (const tr of traces) {
        const args = tr.args.map((a) => hydrate(a));
        const thisArg = tr.thisArg ? hydrate(tr.thisArg) : undefined;
        await spawn({ symbol: sym.exportName, args, thisArg, kind: "call", hyrum }, (r) => {
          recordPoolCall(report, r);
          report.tracesReplayed++;
        });
        if (atCap()) break;
      }

      const shapes = primaryShapes(sym);
      const literals = enumerateLiteralUnions(shapes, 64);
      for (const args of literals) {
        if (Date.now() >= deadline) break;
        if (atCap()) break;
        await spawn({ symbol: sym.exportName, args, kind: "call", hyrum }, (r) => recordPoolCall(report, r));
        if (atCap()) break;
      }

      const replayed = fromTraces(traces, gen);
      while (Date.now() < deadline && !atCap()) {
        const r = gen.next();
        let args: unknown[];
        if (r < 0.7 && replayed.length) {
          const base = gen.pick(replayed);
          args = r < 0.35 ? (base.slice() as unknown[]) : mutateArgs(base, gen);
        } else if (r < 0.9 && shapes.length) {
          args = fromShapes(shapes, gen);
        } else {
          const argc = observedArgc(sym) || 2;
          args = junkArgs(argc, gen);
        }
        await spawn({ symbol: sym.exportName, args, kind: "call", hyrum }, (res) => recordPoolCall(report, res));
      }
    }
    await Promise.all(pending);
  } finally {
    await pool.close();
  }

  report.wallMs = Date.now() - t0;
  return report;
}

function emptyReport(seed: number): FuzzReport {
  return {
    cases: 0,
    comparisons: 0,
    timerCases: 0,
    disagreements: [],
    tracesReplayed: 0,
    wallMs: 0,
    seed,
  };
}

function recordPoolCall(report: FuzzReport, r: FuzzResult): void {
  report.cases++;
  report.comparisons++;
  if (r.ok) return;
  if (report.disagreements.length < MAX_DISAGREEMENTS) {
    report.disagreements.push({
      symbol: r.symbol,
      args: r.args ?? [],
      reason: r.reason ?? "mismatch",
    });
  }
}

function recordPoolDebounce(report: FuzzReport, r: FuzzResult, script: DebounceScript): void {
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

function recordCall(
  report: FuzzReport,
  origFn: Function,
  slimFn: Function,
  symbol: string,
  args: unknown[],
  thisArg: unknown,
  hyrum: Partial<HyrumFlags> | undefined,
  deadline: number,
): void {
  const o = invoke(origFn, args, thisArg);
  const s = invoke(slimFn, args, thisArg);
  const cmp = equalResults(o, s, hyrum);
  report.cases++;
  report.comparisons++;
  if (cmp.ok) return;
  let minimized: unknown[] | undefined;
  const remaining = deadline - Date.now();
  if (remaining > 0) {
    minimized = minimize(
      args,
      (a) => {
        const oo = invoke(origFn, a, thisArg);
        const ss = invoke(slimFn, a, thisArg);
        report.comparisons++;
        return !equalResults(oo, ss, hyrum).ok;
      },
      Math.min(MINIMIZE_MS, remaining),
    );
  }
  if (report.disagreements.length < MAX_DISAGREEMENTS) {
    report.disagreements.push({
      symbol,
      args,
      reason: cmp.reason ?? "mismatch",
      minimized,
    });
  }
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
    reason: !spiesOk
      ? "debounce spy timeline mismatch"
      : "debounce return/flush mismatch",
  });
}

function traceHits(tr: TraceEvent, sym: SymbolEnvelope): boolean {
  if (tr.symbol === sym.exportName) return true;
  const path = sym.callSites[0]?.memberPath?.join(".");
  return path !== undefined && tr.symbol === path;
}

function primaryShapes(sym: SymbolEnvelope): ArgShape[] {
  return sym.callSites[0]?.argShapes ?? [];
}

function observedArgc(sym: SymbolEnvelope): number {
  const obs = sym.callSites.flatMap((c) => c.argc.observed);
  if (!obs.length) return 2;
  return Math.max(...obs);
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
