import type { Envelope, TraceEvent } from "./types.ts";

export function mergeTraces(env: Envelope, traces: TraceEvent[]): Envelope {
  const bySymbol = new Map<string, TraceEvent[]>();
  for (const t of traces) {
    const list = bySymbol.get(t.symbol) ?? [];
    list.push(t);
    bySymbol.set(t.symbol, list);
  }
  const symbols = env.symbols.map((s) => {
    const hits = bySymbol.get(s.exportName) ?? [];
    const tracedIds = new Set<string>();
    for (const c of s.callSites) {
      if (hits.length) tracedIds.add(c.id);
    }
    return {
      ...s,
      coverage: {
        callSitesStatic: s.callSites.length,
        callSitesTraced: hits.length ? s.callSites.length : s.coverage.callSitesTraced,
      },
    };
  });
  const unknowns = env.unknowns.map((u) => {
    if (u.kind !== "dynamic-member") return u;
    const members = [
      ...new Set(
        traces
          .map((t) => t.symbol)
          .filter((name) => name.length > 0),
      ),
    ];
    if (!members.length) return u;
    return { ...u, traceObservedMembers: members };
  });
  return { ...env, symbols, unknowns, traces: [...env.traces, ...traces] };
}
