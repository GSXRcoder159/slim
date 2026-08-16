import type { Envelope, SlimmableVerdict } from "./types.ts";

export function scoreSlimmable(env: Envelope): Envelope["slimmable"] {
  const reasons: string[] = [];
  const blockers = [...env.slimmable.blockers];
  let score = 0;

  const refuseUnknown = env.unknowns.some((u) => u.widensTo === "refuse");
  if (refuseUnknown) {
    blockers.push("unknown site refuses this module");
  }
  if (env.slimmable.verdict === "refuse" && env.slimmable.blockers.length) {
    return { score: 0, verdict: "refuse", blockers, reasons: env.slimmable.reasons };
  }

  const usedGraphPure = !env.unknowns.some((u) =>
    ["eval", "namespace-escape"].includes(u.kind),
  );
  if (usedGraphPure) {
    score += 40;
    reasons.push("used import graph has no eval/namespace-escape");
  }
  if (env.unknowns.length === 0) {
    score += 20;
    reasons.push("no unknown sites");
  }
  const allTraced = env.symbols.every(
    (s) => s.callSites.length === 0 || s.coverage.callSitesTraced > 0,
  );
  if (allTraced && env.traces.length) {
    score += 15;
    reasons.push("all static call sites have traces");
  }
  if (env.symbols.length > 0 && env.symbols.length <= 3) {
    score += 10;
    reasons.push("≤3 symbols");
  }
  if (blockers.length) score -= 50;

  let verdict: SlimmableVerdict = "slim";
  if (blockers.length) verdict = "refuse";
  else if (score < 50 || env.unknowns.length) verdict = "review";

  return { score, verdict, blockers, reasons };
}

export function applySlimmable(env: Envelope): Envelope {
  return { ...env, slimmable: scoreSlimmable(env) };
}
