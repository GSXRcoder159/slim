import {
  ENVELOPE_VERSION,
  emptyHyrum,
  type Envelope,
  type ImportKind,
} from "../../src/envelope/types.ts";

const LOC = { file: "t.ts", line: 1, column: 0, endLine: 1, endColumn: 1 };

export function catalogEnvelope(opts: {
  name: string;
  version: string;
  family?: string;
  symbols: string[];
  importKind?: ImportKind;
  clock?: boolean;
  cryptoRandom?: boolean;
  resultMembers?: Record<string, string[]>;
}): Envelope {
  const family = opts.family ?? opts.name;
  return {
    schemaVersion: ENVELOPE_VERSION,
    package: { name: opts.name, version: opts.version, family, subpath: "" },
    env: ["node"],
    imports: [
      {
        loc: LOC,
        specifier: opts.name,
        kind: opts.importKind ?? "named",
        names: opts.symbols,
      },
    ],
    symbols: opts.symbols.map((exportName) => ({
      exportName,
      packages: [{ name: opts.name, version: opts.version, family, subpath: "" }],
      callSites: [
        {
          id: `${exportName}-1`,
          loc: LOC,
          exportName,
          memberPath: [exportName],
          thisBinding: { kind: "unbound" },
          argc: { min: 0, max: 1, observed: [0] },
          argShapes: [],
          spread: false,
          resultMembers: opts.resultMembers?.[exportName] ?? [],
        },
      ],
      resultMembers: opts.resultMembers?.[exportName] ?? [],
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
      reason: "qualify",
    },
    slimmable: { score: 1, verdict: "slim", blockers: [], reasons: [] },
    clock: opts.clock ?? false,
    cryptoRandom: opts.cryptoRandom ?? false,
  };
}
