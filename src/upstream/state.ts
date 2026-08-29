import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hasStandingTests, hardeningTestPaths, standingTestPaths } from "../evidence/paths.ts";
import {
  fixtureRevision,
  hardeningSuiteBytes,
  sha256Bytes,
  sha256File,
  standingSuiteBytes,
  type ArtifactDigests,
} from "../evidence/digests.ts";
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
  package?: { name?: string; version?: string };
  generation?: {
    kind?: string;
    catalogIds?: unknown;
    provider?: string;
  };
  artifacts?: Partial<ArtifactDigests>;
}

function sameSymbolSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((s) => set.has(s));
}

function slimPin(
  root: string,
  pkg: string,
): { version: string; module: string } | null {
  const p = join(root, "slim.json");
  if (!existsSync(p)) return null;
  try {
    const slim = JSON.parse(readFileSync(p, "utf8")) as {
      replacements?: Record<string, { version?: string; module?: string }>;
    };
    const rec = slim.replacements?.[pkg];
    if (!rec?.version || !rec.module) return null;
    return { version: rec.version, module: rec.module };
  } catch {
    return null;
  }
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

function installedOracleVersion(root: string, pkg: string): string | false | null {
  const abs = join(root, "node_modules", ...pkg.split("/"), "package.json");
  if (!existsSync(abs)) return null;
  try {
    const json = JSON.parse(readFileSync(abs, "utf8")) as { version?: unknown };
    if (typeof json.version !== "string" || !json.version) return false;
    return json.version;
  } catch {
    return false;
  }
}

function artifactDrift(
  root: string,
  pkg: string,
  outDir: string,
  moduleRel: string | undefined,
  ev: EvidenceDoc,
  envelope: Envelope | null,
  rec: ReplacementRecord | null | undefined,
  pin: { version: string; module: string } | null,
): EnvelopeDrift[] {
  const a = ev.artifacts;
  if (
    !a?.moduleDigest ||
    !a.standingDigest ||
    !a.hardeningDigest ||
    !a.oracleVersion ||
    !a.fixtureRevision
  ) {
    return [{ kind: "evidence", detail: `evidence.json for ${pkg} is missing artifacts` }];
  }
  const drift: EnvelopeDrift[] = [];
  if (moduleRel && existsSync(join(root, moduleRel))) {
    const live = sha256File(join(root, moduleRel));
    if (live !== a.moduleDigest) {
      drift.push({ kind: "digest", detail: `evidence.json moduleDigest does not match module for ${pkg}` });
    }
  }
  const standing = standingSuiteBytes(root, pkg, outDir);
  if (standing && sha256Bytes(standing) !== a.standingDigest) {
    drift.push({ kind: "digest", detail: `evidence.json standingDigest does not match standing suite for ${pkg}` });
  }
  if (moduleRel) {
    const hardening = hardeningSuiteBytes(root, moduleRel);
    if (hardening && sha256Bytes(hardening) !== a.hardeningDigest) {
      drift.push({ kind: "digest", detail: `evidence.json hardeningDigest does not match hardening suite for ${pkg}` });
    }
    if (standing && hardening && fixtureRevision(standing, hardening) !== a.fixtureRevision) {
      drift.push({
        kind: "digest",
        detail: `evidence.json fixtureRevision does not match standing and hardening for ${pkg}`,
      });
    }
  }
  const want = a.oracleVersion;
  if (envelope && want !== envelope.package.version) {
    drift.push({
      kind: "version",
      detail: `evidence.json oracleVersion ${want} != envelope ${envelope.package.version}`,
    });
  }
  if (ev.package?.version && want !== ev.package.version) {
    drift.push({
      kind: "version",
      detail: `evidence.json oracleVersion ${want} != package ${ev.package.version}`,
    });
  }
  if (rec?.version && want !== rec.version) {
    drift.push({ kind: "version", detail: `evidence.json oracleVersion ${want} != manifest ${rec.version}` });
  }
  if (pin && want !== pin.version) {
    drift.push({ kind: "version", detail: `evidence.json oracleVersion ${want} != slim.json ${pin.version}` });
  }
  const installed = installedOracleVersion(root, pkg);
  if (installed === false) {
    drift.push({ kind: "version", detail: `installed ${pkg} package.json is unreadable` });
  } else if (installed && installed !== want) {
    drift.push({
      kind: "version",
      detail: `installed ${pkg}@${installed} != evidence oracleVersion ${want}`,
    });
  }
  return drift;
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
  if (rec && envelope && rec.version !== envelope.package.version) {
    push(drift, "version", `manifest version ${rec.version} != envelope ${envelope.package.version}`);
  }
  if (rec && envelope) {
    const envSymbols = envelope.symbols.map((s) => s.exportName);
    if (!sameSymbolSet(rec.symbols, envSymbols)) {
      push(drift, "symbol", `manifest symbols do not match envelope for ${pkg}`);
    }
  }
  const pin = slimPin(root, pkg);
  if (pin && envelope && pin.version !== envelope.package.version) {
    push(drift, "version", `slim.json version ${pin.version} != envelope ${envelope.package.version}`);
  }
  if (pin && rec && pin.module !== rec.module) {
    push(drift, "exports", `slim.json module ${pin.module} != manifest ${rec.module}`);
  }

  const evidencePath = join(root, ".slim", pkg, "evidence.json");
  let evidence: EvidenceDoc | null = null;
  if (!existsSync(evidencePath)) {
    push(drift, "evidence", `missing evidence ${evidencePath}`);
  } else {
    try {
      evidence = readDocument("evidence", evidencePath, "evidence.json") as EvidenceDoc;
      if (hash && evidence.envelopeHash !== hash) {
        push(drift, "hash", `evidence.json envelopeHash does not match envelope for ${pkg}`);
      }
      if (envelope && evidence.package?.name && evidence.package.name !== envelope.package.name) {
        push(drift, "evidence", `evidence.json package name mismatch for ${pkg}`);
      }
      if (envelope && evidence.package?.version && evidence.package.version !== envelope.package.version) {
        push(drift, "version", `evidence.json version ${evidence.package.version} != envelope ${envelope.package.version}`);
      }
      residualRisk = Array.isArray(evidence.residualRisk) ? evidence.residualRisk.map(String) : [];
      drift.push(...generationDrift(evidence, pkg));
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

  if (evidence) {
    drift.push(...artifactDrift(root, pkg, outDir, moduleRel, evidence, envelope, rec, pin));
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
