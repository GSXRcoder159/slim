import type { CliArgs } from "../cli.ts";
import type { SlimConfig } from "../config.ts";
import { type Envelope } from "../envelope/types.ts";
import { matchCatalog } from "../generate/catalog/index.ts";
import { type LlmConfig } from "../generate/llm.ts";
import { type FuzzReport } from "../fuzz/run.ts";
import { MutationTxn } from "../rewrite/transaction.ts";
import type { OsvVuln } from "./osv.ts";
import type { NpmLatest } from "./npm.ts";
import type { CreatePrOpts, PrResult } from "../github/pr.ts";
import type { Exposure } from "./slice.ts";
import type { SourceResult } from "./status.ts";
import { type ReplacementRecord } from "./state.ts";
export type ManifestReplacement = ReplacementRecord;
export interface UpstreamFinding {
    package: string;
    pinned: string;
    latest: string;
    id: string;
    summary?: string;
    details?: string;
    exposure: Exposure;
    affectedRange: string;
    usedSymbols: string[];
    mappedEvidence: string;
    upstreamChange: string;
    unmappedReason: string | null;
}
export interface UpstreamDeps {
    cwd?: string;
    queryOsv?: (name: string, version: string) => Promise<SourceResult<OsvVuln[]>>;
    npmLatest?: (name: string) => Promise<SourceResult<NpmLatest>>;
    githubStatus?: () => SourceResult<true>;
    assembleCatalogModule?: (env: Envelope, projectRoot?: string) => string | null;
    matchCatalog?: typeof matchCatalog;
    runFuzz?: (opts: {
        original?: Record<string, Function>;
        replacement?: Record<string, Function>;
        origModule?: string;
        slimModule?: string;
        envelope: Envelope;
        budgetMs: number;
        seed: number;
        workers?: number;
    }) => Promise<FuzzReport>;
    generateWithLlm?: (envelope: Envelope, publicApi: import("../generate/public-api.ts").PublicApiSpec, counterexamples: string[], cfg: LlmConfig) => Promise<{
        source: string;
        promptHash: string;
    }>;
    llmConfigFromEnv?: (env?: NodeJS.ProcessEnv) => LlmConfig | null;
    createPullRequest?: (opts: CreatePrOpts) => Promise<PrResult>;
    installUpstream?: (name: string, version: string) => Promise<string | null>;
    loadOracle?: (pkg: string, version: string, symbols: string[]) => Promise<UpstreamOracle | null>;
    runStandingTests?: (root: string, pkg: string, outDir: string) => void;
    runHardenedTests?: (root: string, moduleRel: string | undefined) => void;
}
export interface UpstreamOracle {
    fns: Record<string, Function>;
    /** "new" = temp-installed latest/patched; "old" = pinned/still-vulnerable project install. */
    kind: "new" | "old";
    tempDir?: string;
}
export interface ApplyUpstreamFixOpts {
    root: string;
    pkg: string;
    rec: ManifestReplacement;
    findings: UpstreamFinding[];
    args: CliArgs;
    config: SlimConfig;
}
export interface ApplyUpstreamFixResult {
    pkg: string;
    regenerated: boolean;
    usedCatalog: boolean;
    fuzzed: boolean;
    fuzzSkipReason: string | null;
    fuzz: {
        cases: number;
        comparisons: number;
        timerCases: number;
    } | null;
    hardenedTest: string | null;
    oracleKind: "new" | "old" | null;
    oracleVersion: string | null;
    residualRisk: string[];
}
export declare function canFuzzOracle(opts: ApplyUpstreamFixOpts, deps?: UpstreamDeps): Promise<boolean>;
export declare function applyUpstreamFix(opts: ApplyUpstreamFixOpts, deps?: UpstreamDeps, sharedTxn?: MutationTxn): Promise<ApplyUpstreamFixResult>;
export declare function advisoryAbstracts(findings: UpstreamFinding[]): string[];
export declare function assertHardenedGetSet(fns: Record<string, Function>): void;
export { emitHardenedGetSetTest } from "../evidence/emit-tests.ts";
export declare function installUpstreamInTemp(name: string, version: string): Promise<string | null>;
