import { ENVELOPE_VERSION, emptyHyrum, hashEnvelope, type Envelope } from "../../src/envelope/types.ts";
import type { EvidenceJson } from "../../src/evidence/report.ts";

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
