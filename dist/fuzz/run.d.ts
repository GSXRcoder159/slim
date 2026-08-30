import type { Envelope, SymbolEnvelope, TraceEvent } from "../envelope/types.ts";
import { isExportTrace } from "./gen.ts";
export interface FuzzReport {
    cases: number;
    comparisons: number;
    timerCases: number;
    disagreements: Array<{
        symbol: string;
        args: unknown[];
        reason: string;
        minimized?: unknown[];
    }>;
    tracesReplayed: number;
    wallMs: number;
    seed: number;
    allowFlaky: boolean;
}
export declare function defaultWorkerCount(): number;
export declare function isInjectableCrypto(pkg: string): boolean;
export declare function runFuzz(opts: {
    original?: Record<string, Function>;
    replacement?: Record<string, Function>;
    origModule?: string;
    slimModule?: string;
    slimHash?: string;
    envelope: Envelope;
    budgetMs: number;
    seed: number;
    /** Default: max(1, availableParallelism()-1). Tests that need determinism pass 1. */
    workers?: number;
    allowFlaky?: boolean;
    projectRoot?: string;
}): Promise<FuzzReport>;
export declare function traceHits(tr: TraceEvent, sym: SymbolEnvelope): boolean;
export { isExportTrace };
