import type { Envelope, Confidence } from "./types.ts";

export function closeEnvelope(env: Envelope, opts?: { allowUnknown?: boolean }): Envelope {
  const untraced = env.symbols.flatMap((s) =>
    s.callSites
      .filter((c) => s.coverage.callSitesTraced === 0)
      .map((c) => c.id),
  );
  const hardUnknowns = env.unknowns.filter((u) => u.widensTo === "refuse");
  const dynamic = env.unknowns.filter((u) => u.kind === "dynamic-member");
  const traceClosed =
    dynamic.length > 0 &&
    dynamic.every((u) => (u.traceObservedMembers?.length ?? 0) > 0) &&
    Boolean(opts?.allowUnknown);

  let confidence: Confidence = "closed";
  let ready = true;
  let reason = "static envelope closed";

  if (hardUnknowns.length) {
    confidence = "open";
    ready = false;
    reason = hardUnknowns.map((u) => u.detail).join("; ");
  } else if (env.unknowns.length && !traceClosed) {
    confidence = "open";
    ready = Boolean(opts?.allowUnknown);
    reason = env.unknowns.map((u) => `${u.kind}: ${u.detail}`).join("; ");
  } else if (traceClosed) {
    confidence = "trace-closed";
    ready = true;
    reason = "dynamic members closed by traces (--allow-unknown)";
  }

  if (env.slimmable.verdict === "refuse") {
    ready = false;
    reason = env.slimmable.blockers.join("; ") || reason;
  }

  if (confidence === "closed" && env.traces.length === 0) {
    const phrase =
      "no traces — generators are static-shape plus catalog mutations, not your runtime distribution";
    if (!reason.includes(phrase)) {
      reason = reason ? `${reason}; ${phrase}` : phrase;
    }
  } else if (untraced.length && ready) {
    reason +=
      "; no traces — generators are static-shape plus catalog mutations, not your runtime distribution";
  }

  return {
    ...env,
    closure: {
      confidence,
      readyToGenerate: ready && env.slimmable.verdict !== "refuse",
      untracedCallSiteIds: untraced,
      reason,
    },
  };
}
