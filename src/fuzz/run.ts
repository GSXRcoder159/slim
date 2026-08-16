import type { ArgShape, Envelope, HyrumFlags, SymbolEnvelope, TraceEvent } from "../envelope/types.ts";
import { invoke, equalResults, equal } from "./equal.ts";
import { createGen, fromTraces, mutateArgs, fromShapes, junkArgs, enumerateLiteralUnions, hydrate } from "./gen.ts";
import { minimize } from "./minimize.ts";
import { createFakeClock } from "./clock.ts";
import {
  runDebounceScript,
  taxonomyForObserved,
  isTimerSymbol,
  TAXONOMY,
  type DebounceScript,
} from "./debounce-driver.ts";

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

export async function runFuzz(opts: {
  original: Record<string, Function>;
  replacement: Record<string, Function>;
  envelope: Envelope;
  budgetMs: number;
  seed: number;
  /** Module-isolation parallelism lives in createPool; in-process run is sequential. */
  workers?: number;
}): Promise<FuzzReport> {
  const t0 = Date.now();
  const deadline = t0 + Math.max(0, opts.budgetMs);
  const gen = createGen(opts.seed);
  const report: FuzzReport = {
    cases: 0,
    comparisons: 0,
    timerCases: 0,
    disagreements: [],
    tracesReplayed: 0,
    wallMs: 0,
    seed: opts.seed,
  };
  void opts.workers;

  const timerSymbols = opts.envelope.symbols.filter((s) => isTimerSymbol(s.exportName));
  const valueSymbols = opts.envelope.symbols.filter((s) => !isTimerSymbol(s.exportName));

  for (const sym of timerSymbols) {
    const origFn = opts.original[sym.exportName];
    const slimFn = opts.replacement[sym.exportName];
    if (typeof origFn !== "function" || typeof slimFn !== "function") continue;
    const hyrum = sym.hyrum;
    const scripts = scriptsForSymbol(sym, opts.envelope);
    for (const script of scripts) {
      await recordDebounce(report, origFn, slimFn, sym.exportName, script, hyrum);
      if (report.disagreements.length >= MAX_DISAGREEMENTS) break;
    }
  }

  for (const sym of valueSymbols) {
    if (Date.now() >= deadline && report.cases > 0) break;
    if (report.disagreements.length >= MAX_DISAGREEMENTS) break;
    const origFn = opts.original[sym.exportName];
    const slimFn = opts.replacement[sym.exportName];
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

  report.wallMs = Date.now() - t0;
  return report;
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
): Promise<void> {
    const clockOrig = createFakeClock(0);
    const clockSlim = createFakeClock(0);
    const a = await runDebounceScript(origFn, script, clockOrig);
    const b = await runDebounceScript(slimFn, script, clockSlim);
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
  });
  if (selected.length) return selected;
  if (envelope.clock || isTimerSymbol(sym.exportName)) {
    return Object.values(TAXONOMY);
  }
  return [];
}
