import type { Envelope, Confidence } from "./types.ts";

const NO_TRACES =
  "no traces — generators are static-shape plus catalog mutations, not your runtime distribution";

export function closeEnvelope(
  env: Envelope,
  opts?: { allowUnknown?: boolean; staticOnly?: boolean },
): Envelope {
  const staticCallSiteIds = env.symbols.flatMap((s) => s.callSites.map((c) => c.id));
  const staticSet = new Set(staticCallSiteIds);
  const tracedCallSiteIds = [
    ...new Set(
      env.traces
        .filter((t) => t.callSiteId && !t.unmatched && staticSet.has(t.callSiteId))
        .map((t) => t.callSiteId!),
    ),
  ];
  const traced = new Set(tracedCallSiteIds);
  const untraced = staticCallSiteIds.filter((id) => !traced.has(id));
  const unmatched = env.traces.filter((t) => t.unmatched);
  const hardUnknowns = env.unknowns.filter((u) => u.widensTo === "refuse");
  const dynamic = env.unknowns.filter((u) => u.kind === "dynamic-member");
  const traceClosed =
    dynamic.length > 0 &&
    dynamic.every((u) => (u.traceObservedMembers?.length ?? 0) > 0) &&
    Boolean(opts?.allowUnknown) &&
    unmatched.length === 0;

  const hasBehavior = env.symbols.some((s) => s.callSites.length > 0);

  let confidence: Confidence = "closed";
  let ready = true;
  let reason = "static envelope closed";

  if (env.imports.length === 0 && env.symbols.length === 0) {
    confidence = "open";
    ready = false;
    reason = "no runtime import sites observed";
  } else if (hardUnknowns.length) {
    confidence = "open";
    ready = false;
    reason = hardUnknowns.map((u) => u.detail).join("; ");
  } else if (env.unknowns.length && !traceClosed) {
    confidence = "open";
    ready = Boolean(opts?.allowUnknown);
    reason = env.unknowns.map((u) => `${u.kind}: ${u.detail}`).join("; ");
    if (ready) reason += "; --allow-unknown (unsafe override, not closed)";
  } else if (traceClosed) {
    confidence = "trace-closed";
    ready = true;
    reason = "dynamic members closed by traces (--allow-unknown)";
  } else if (!hasBehavior) {
    confidence = "open";
    ready = false;
    reason = "no represented runtime behavior";
  }

  if (opts?.staticOnly && confidence === "trace-closed") {
    confidence = "closed";
    reason = "static envelope closed";
  }

  if (unmatched.length && confidence === "trace-closed") {
    confidence = "open";
    reason = "unmatched trace events block trace closure";
  } else if (unmatched.length && confidence === "closed") {
    reason += "; unmatched trace events block trace closure";
  }

  if (env.slimmable.verdict === "refuse") {
    ready = false;
    reason = env.slimmable.blockers.join("; ") || reason;
  }

  if (env.traces.length === 0) {
    if (!reason.includes(NO_TRACES)) {
      reason = reason ? `${reason}; ${NO_TRACES}` : NO_TRACES;
    }
    if (opts?.staticOnly && !reason.includes("--no-trace")) {
      reason += "; --no-trace (static-only, cannot claim trace-closed)";
    }
  } else if (untraced.length && ready && !reason.includes("untraced")) {
    reason += `; ${untraced.length} static call site(s) untraced`;
  }

  return {
    ...env,
    closure: {
      confidence,
      readyToGenerate: ready && env.slimmable.verdict !== "refuse",
      staticCallSiteIds,
      tracedCallSiteIds,
      untracedCallSiteIds: untraced,
      reason,
    },
  };
}
