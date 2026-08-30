import type { Envelope } from "../envelope/types.ts";
import { type BundleDelta } from "../size/bundle.ts";
import { type RevertPlan } from "../rewrite/revert.ts";
import type { SpecSource } from "../generate/public-api.ts";
import { type ArtifactDigests } from "./digests.ts";
export interface GenerationEvidence {
    kind: "catalog" | "llm";
    catalogIds: string[];
    provider?: "anthropic" | "openai";
    model?: string;
    promptHash?: string;
    attempts: number;
    specSource: SpecSource | "catalog";
    limitation?: string;
    counterexamples: string[];
}
export declare const EVIDENCE_SCHEMA_VERSION: 1;
export interface EvidenceJson {
    schemaVersion: typeof EVIDENCE_SCHEMA_VERSION;
    slogan: "EVIDENCE, NOT PROOF";
    package: Envelope["package"];
    envelopeHash: string;
    symbols: string[];
    callSites: number;
    unknowns: number;
    byteDelta: {
        originalMin: number | null;
        replacement: number;
        gzipOriginal: number | null;
        bundle?: BundleDelta;
    };
    fuzz: {
        cases: number;
        comparisons: number;
        timerCases: number;
        tracesReplayed: number;
        wallMs: number;
        seed: number;
        disagreements: number;
        allowFlaky?: boolean;
    };
    coverageHoles: string[];
    residualRisk: string[];
    revert: RevertPlan;
    generation?: GenerationEvidence;
    artifacts: ArtifactDigests;
}
export declare function writeEvidence(opts: {
    root: string;
    env: Envelope;
    replacementBytes: number;
    originalMin: number | null;
    fuzz: EvidenceJson["fuzz"];
    catalogIds: string[];
    coverageHoles: string[];
    bundle?: BundleDelta | null;
    revert: RevertPlan;
    generation?: Partial<GenerationEvidence>;
    moduleSource?: string | Buffer;
    dir?: string;
}): {
    mdPath: string;
    jsonPath: string;
    residualRisk: string[];
};
export declare function renderEvidenceMd(json: EvidenceJson, env: Envelope, catalogIds?: string[], digests?: {
    evidenceHash?: string;
}): string;
