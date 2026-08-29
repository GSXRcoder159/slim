import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ENVELOPE_VERSION, emptyHyrum, hashEnvelope, type Envelope } from "../../src/envelope/types.ts";
import type { EvidenceJson } from "../../src/evidence/report.ts";
import { artifactDigests, fixtureRevision, sha256Bytes, type ArtifactDigests } from "../../src/evidence/digests.ts";

export const DEFAULT_SLICE_SOURCE = "export function get() { return 1; }\n";
export const DEFAULT_STANDING_SOURCE = `import { test } from "node:test";\ntest("standing", () => {});\n`;
export const DEFAULT_HARDENING_SOURCE = `import { test } from "node:test";\ntest("hardened", () => {});\n`;

export function boundArtifacts(opts: {
  module?: string | Buffer;
  standing?: string | Buffer;
  hardening?: string | Buffer;
  oracleVersion: string;
}): ArtifactDigests {
  const standing = Buffer.from(opts.standing ?? DEFAULT_STANDING_SOURCE);
  const hardening = Buffer.from(opts.hardening ?? DEFAULT_HARDENING_SOURCE);
  return {
    moduleDigest: sha256Bytes(opts.module ?? DEFAULT_SLICE_SOURCE),
    standingDigest: sha256Bytes(standing),
    hardeningDigest: sha256Bytes(hardening),
    oracleVersion: opts.oracleVersion,
    fixtureRevision: fixtureRevision(standing, hardening),
  };
}

export function plantReplacementTree(
  root: string,
  opts: {
    pkg?: string;
    moduleRel?: string;
    module?: string;
    standing?: string;
    hardening?: string;
  } = {},
): void {
  const pkg = opts.pkg ?? "lodash";
  const moduleRel = opts.moduleRel ?? `src/slim/${pkg}.ts`;
  const base = moduleRel.replace(/\.(ts|js|mjs|cjs)$/, "");
  mkdirSync(join(root, dirname(moduleRel)), { recursive: true });
  writeFileSync(join(root, moduleRel), opts.module ?? DEFAULT_SLICE_SOURCE);
  writeFileSync(join(root, `${base}.test.ts`), opts.standing ?? DEFAULT_STANDING_SOURCE);
  writeFileSync(join(root, `${base}.hardened.test.ts`), opts.hardening ?? DEFAULT_HARDENING_SOURCE);
}

export function rebindEvidenceArtifacts(root: string, pkg: string, outDir = "src/slim"): void {
  const evidencePath = join(root, ".slim", pkg, "evidence.json");
  const envPath = join(root, ".slim", pkg, "envelope.json");
  if (!existsSync(evidencePath) || !existsSync(envPath)) return;
  let ev: EvidenceJson;
  try {
    ev = JSON.parse(readFileSync(evidencePath, "utf8")) as EvidenceJson;
  } catch {
    return;
  }
  if (!ev.artifacts || typeof ev.artifacts !== "object") return;
  const env = JSON.parse(readFileSync(envPath, "utf8")) as Envelope;
  let moduleRel = `src/slim/${pkg}.ts`;
  const manPath = join(root, ".slim", "manifest.json");
  if (existsSync(manPath)) {
    try {
      const man = JSON.parse(readFileSync(manPath, "utf8")) as {
        replacements?: Record<string, { module?: string }>;
      };
      if (man.replacements?.[pkg]?.module) moduleRel = man.replacements[pkg].module;
    } catch {
      /* keep default */
    }
  }
  try {
    ev.artifacts = artifactDigests({
      root,
      pkg,
      outDir,
      moduleRel,
      oracleVersion: env.package.version,
    });
    writeFileSync(evidencePath, JSON.stringify(ev) + (evidencePath.endsWith(".json") ? "\n" : ""));
  } catch {
    /* incomplete tree */
  }
}

export function minimalEnvelope(pkg = "lodash", symbols = ["get"], version = "4.17.21"): Envelope {
  return {
    schemaVersion: ENVELOPE_VERSION,
    package: {
      name: pkg,
      version,
      family: pkg.startsWith("lodash") || pkg === "underscore" ? "lodash" : pkg,
      subpath: "",
    },
    env: ["node"],
    imports: [
      {
        loc: { file: "src/index.ts", line: 1, column: 0, endLine: 1, endColumn: 10 },
        specifier: pkg,
        kind: "named",
        names: symbols,
      },
    ],
    symbols: symbols.map((exportName) => ({
      exportName,
      packages: [],
      callSites: [],
      resultMembers: [],
      hyrum: emptyHyrum(),
      coverage: { callSitesStatic: 1, callSitesTraced: 0 },
    })),
    unknowns: [],
    traces: [],
    closure: {
      confidence: "closed",
      readyToGenerate: true,
      staticCallSiteIds: [],
      tracedCallSiteIds: [],
      untracedCallSiteIds: [],
      reason: "test",
    },
    slimmable: { score: 80, verdict: "slim", blockers: [], reasons: [] },
    clock: false,
    cryptoRandom: false,
  };
}

export function minimalEvidence(env: Envelope, over: Partial<EvidenceJson> = {}): EvidenceJson {
  return {
    schemaVersion: 1,
    slogan: "EVIDENCE, NOT PROOF",
    package: env.package,
    envelopeHash: hashEnvelope(env),
    symbols: env.symbols.map((s) => s.exportName),
    callSites: env.symbols.reduce((n, s) => n + s.callSites.length, 0),
    unknowns: env.unknowns.length,
    byteDelta: { originalMin: 1000, replacement: 100, gzipOriginal: 360 },
    fuzz: {
      cases: 1,
      comparisons: 1,
      timerCases: 0,
      tracesReplayed: 0,
      wallMs: 1,
      seed: 1,
      disagreements: 0,
    },
    coverageHoles: [],
    residualRisk: ["strong evidence, not proof"],
    revert: {
      package: env.package.name,
      version: env.package.version,
      module: `src/slim/${env.package.name}.ts`,
      tests: `src/slim/${env.package.name}.test.ts`,
      cjsCompanion: null,
      rewrites: [],
      lockfile: "npm",
      installCommand: "npm install",
    },
    generation: {
      kind: "catalog",
      catalogIds: [`${env.package.name}.get`],
      attempts: 1,
      specSource: "catalog",
      counterexamples: [],
    },
    artifacts: boundArtifacts({ oracleVersion: env.package.version }),
    ...over,
  };
}

export function minimalManifest(env: Envelope, moduleRel?: string) {
  return {
    schemaVersion: 1 as const,
    replacements: {
      [env.package.name]: {
        version: env.package.version,
        envelopeHash: hashEnvelope(env),
        symbols: env.symbols.map((s) => s.exportName),
        module: moduleRel ?? `src/slim/${env.package.name}.ts`,
      },
    },
  };
}
