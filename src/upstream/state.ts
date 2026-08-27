import { existsSync } from "node:fs";
import { join } from "node:path";
import { hasStandingTests, hardeningTestPaths, standingTestPaths } from "../evidence/paths.ts";
import type { EnvelopeDrift } from "../envelope/drift.ts";
import { hashEnvelope, type Envelope } from "../envelope/types.ts";
import { EXIT_FAIL, SlimExit } from "../exit.ts";
import { readDocument } from "../schema/documents.ts";

export interface ReplacementRecord {
  version: string;
  envelopeHash: string;
  symbols: string[];
  module: string;
}

export interface ReplacementState {
  envelope: Envelope | null;
  residualRisk: string[];
  drift: EnvelopeDrift[];
  fatal: SlimExit | null;
}

interface EvidenceDoc {
  envelopeHash?: string;
  residualRisk?: unknown;
  generation?: {
    kind?: string;
    catalogIds?: unknown;
    provider?: string;
  };
}

function push(drift: EnvelopeDrift[], kind: string, detail: string): void {
  drift.push({ kind, detail });
}

function generationDrift(ev: EvidenceDoc, pkg: string): EnvelopeDrift[] {
  const g = ev.generation;
  if (!g) return [{ kind: "evidence", detail: `evidence.json for ${pkg} is missing generation` }];
  if (g.kind === "catalog" && (!Array.isArray(g.catalogIds) || g.catalogIds.length === 0)) {
    return [{ kind: "evidence", detail: `catalog evidence for ${pkg} requires catalogIds` }];
  }
  if (g.kind === "llm" && !g.provider) {
    return [{ kind: "evidence", detail: `llm evidence for ${pkg} requires provider` }];
  }
  return [];
}

export function replacementStateIssues(
  root: string,
  pkg: string,
  rec: ReplacementRecord | null | undefined,
  outDir: string,
  moduleFallback?: string,
): ReplacementState {
  const drift: EnvelopeDrift[] = [];
  let residualRisk: string[] = [];
  let envelope: Envelope | null = null;
  let fatal: SlimExit | null = null;
  let hash: string | null = null;

  if (!rec) {
    push(drift, "manifest", `missing manifest replacement for ${pkg}`);
  } else if (!rec.version || !rec.envelopeHash || !Array.isArray(rec.symbols) || !rec.module) {
    push(drift, "manifest", `malformed manifest replacement for ${pkg}`);
  }

  const envPath = join(root, ".slim", pkg, "envelope.json");
  if (!existsSync(envPath)) {
    push(drift, "envelope", `missing envelope ${envPath}`);
  } else {
    try {
      envelope = readDocument("envelope", envPath, `envelope ${envPath}`) as Envelope;
      if (envelope.package?.name !== pkg) {
        push(drift, "envelope", `envelope package name mismatch in ${envPath}`);
      }
      try {
        hash = hashEnvelope(envelope);
      } catch {
        const err = new SlimExit(EXIT_FAIL, `malformed envelope ${envPath}`);
        fatal = err;
        push(drift, "envelope", err.message);
      }
    } catch (err) {
      const msg = err instanceof SlimExit ? err.message : `malformed envelope ${envPath}`;
      if (err instanceof SlimExit) fatal = err;
      else fatal = new SlimExit(EXIT_FAIL, msg);
      push(drift, "envelope", msg);
    }
  }

  if (rec && hash && rec.envelopeHash !== hash) {
    push(drift, "hash", `manifest envelopeHash does not match envelope for ${pkg}`);
  }

  const evidencePath = join(root, ".slim", pkg, "evidence.json");
  if (!existsSync(evidencePath)) {
    push(drift, "evidence", `missing evidence ${evidencePath}`);
  } else {
    try {
      const ev = readDocument("evidence", evidencePath, "evidence.json") as EvidenceDoc;
      if (hash && ev.envelopeHash !== hash) {
        push(drift, "hash", `evidence.json envelopeHash does not match envelope for ${pkg}`);
      }
      residualRisk = Array.isArray(ev.residualRisk) ? ev.residualRisk.map(String) : [];
      drift.push(...generationDrift(ev, pkg));
    } catch (err) {
      const msg = err instanceof SlimExit ? err.message : `malformed evidence ${evidencePath}`;
      if (err instanceof SlimExit) fatal = fatal ?? err;
      push(drift, "evidence", msg);
    }
  }

  const moduleRel = rec?.module || moduleFallback;
  if (!moduleRel) {
    push(drift, "exports", `missing slice module`);
  } else {
    const moduleAbs = join(root, moduleRel);
    if (!existsSync(moduleAbs)) {
      push(drift, "exports", `missing slice module ${moduleRel}`);
    }
    const hardened = hardeningTestPaths(root, moduleRel);
    if (!existsSync(hardened.tsAbs) && !existsSync(hardened.jsAbs)) {
      push(drift, "hardening", `missing hardening tests for ${moduleRel}`);
    }
  }

  if (!hasStandingTests(root, pkg, outDir)) {
    const standing = standingTestPaths(root, pkg, outDir);
    push(drift, "standing", `missing standing tests for ${pkg} (${standing.tsRel})`);
  }

  return { envelope, residualRisk, drift, fatal };
}

export function assertReplacementState(
  root: string,
  pkg: string,
  rec: ReplacementRecord,
  outDir: string,
): Envelope {
  const state = replacementStateIssues(root, pkg, rec, outDir);
  if (state.drift.length || !state.envelope) {
    throw state.fatal ?? new SlimExit(EXIT_FAIL, state.drift[0]?.detail ?? `incomplete replacement state for ${pkg}`);
  }
  return state.envelope;
}
