import type { EnvelopeDrift } from "../envelope/drift.ts";
import { type Envelope } from "../envelope/types.ts";
import { SlimExit } from "../exit.ts";
export interface ReplacementRecord {
    version: string;
    envelopeHash: string;
    symbols: string[];
    module: string;
}
export type ReplacementStateKind = "ok" | "missing" | "malformed";
export interface ReplacementStateOpts {
    outDir: string;
    envelope?: string;
    moduleFallback?: string;
    ts?: typeof import("typescript");
}
export interface ReplacementPaths {
    envelopeAbs: string;
    envelopeRel: string;
    evidenceAbs: string;
    evidenceRel: string;
    moduleRel?: string;
    moduleAbs?: string;
}
export interface ReplacementState {
    envelope: Envelope | null;
    residualRisk: string[];
    drift: EnvelopeDrift[];
    fatal: SlimExit | null;
    kind: ReplacementStateKind;
    paths: ReplacementPaths | null;
}
export declare function resolveReplacementPaths(root: string, pkg: string, rec: ReplacementRecord | null | undefined, opts: ReplacementStateOpts): ReplacementPaths;
export declare function replacementStateIssues(root: string, pkg: string, rec: ReplacementRecord | null | undefined, opts: ReplacementStateOpts): ReplacementState;
export declare function assertReplacementState(root: string, pkg: string, rec: ReplacementRecord, opts: ReplacementStateOpts): Envelope;
