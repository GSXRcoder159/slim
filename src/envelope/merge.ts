import type { Envelope, HyrumFlags, SlimValue, TraceEvent } from "./types.ts";
import { emptyHyrum } from "./types.ts";
import { attributeTraces, locMatch, symbolMatches } from "../trace/attribute.ts";

export function hyrumFromTraces(traces: TraceEvent[]): Partial<HyrumFlags> {
  const h: Partial<HyrumFlags> = {};
  for (const t of traces) {
    if (t.threw?.message) h.errorMessage = true;
    if (t.mutatedArgIndexes?.length) h.mutation = true;
    for (const v of t.args) walkSlim(v, h);
    if (t.result) walkSlim(t.result, h);
    if (t.thisArg) walkSlim(t.thisArg, h);
  }
  return h;
}

function walkSlim(v: SlimValue, h: Partial<HyrumFlags>, depth = 0): void {
  if (depth > 24) return;
  if (v.t === "trunc") return;
  if (v.t === "num") {
    if (v.v === "NaN") h.nan = true;
    if (v.v === "-0") h.signedZero = true;
  }
  if (v.t === "arr") {
    if (v.holes.length) h.sparseArray = true;
    for (const el of v.v) walkSlim(el, h, depth + 1);
  }
  if (v.t === "obj") {
    if (v.keys.length >= 2) h.keyOrder = true;
    for (const k of v.keys) {
      const child = v.v[k];
      if (child) walkSlim(child, h, depth + 1);
    }
  }
  if (v.t === "map") {
    for (const [k, val] of v.v) {
      walkSlim(k, h, depth + 1);
      walkSlim(val, h, depth + 1);
    }
  }
  if (v.t === "set") {
    for (const el of v.v) walkSlim(el, h, depth + 1);
  }
}

function orHyrum(base: HyrumFlags, extra: Partial<HyrumFlags>): HyrumFlags {
  const out: HyrumFlags = { ...emptyHyrum(), ...base };
  for (const k of Object.keys(extra) as (keyof HyrumFlags)[]) {
    if (extra[k]) out[k] = true;
  }
  return out;
}

export function mergeTraces(
  env: Envelope,
  traces: TraceEvent[],
  opts?: { root?: string },
): Envelope {
  const attributed = opts?.root ? attributeTraces(env, traces, opts.root) : traces;
  const symbols = env.symbols.map((s) => {
    const hits = attributed.filter((t) => symbolMatches(s.exportName, t.symbol));
    const tracedIds = new Set<string>();
    for (const t of hits) {
      if (t.callSiteId && !t.unmatched) tracedIds.add(t.callSiteId);
    }
    return {
      ...s,
      hyrum: orHyrum(s.hyrum, hyrumFromTraces(hits)),
      coverage: {
        callSitesStatic: s.callSites.length,
        callSitesTraced: tracedIds.size,
      },
    };
  });
  const unknowns = env.unknowns.map((u) => {
    if (u.kind !== "dynamic-member") return u;
    const members = [
      ...new Set(
        attributed
          .filter((t) => t.site && locMatch(t.site, u.loc, opts?.root ?? process.cwd()))
          .map((t) => (t.resultMember ? `${baseSymbol(t.symbol)}.${t.resultMember}` : t.symbol))
          .filter((name) => name.length > 0),
      ),
    ];
    if (!members.length) return u;
    return { ...u, traceObservedMembers: members };
  });
  return { ...env, symbols, unknowns, traces: [...env.traces, ...attributed] };
}

function baseSymbol(symbol: string): string {
  return symbol.replace(/\(\)$/, "").split(".")[0] ?? symbol;
}
