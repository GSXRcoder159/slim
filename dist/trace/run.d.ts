import type { Envelope, TraceEvent } from "../envelope/types.ts";
import { type TraceErrorRecord } from "./session.ts";
export declare const TRACE_TIMEOUT_MS = 120000;
export declare const MAX_TRACE_BYTES: number;
export declare const MAX_TRACE_EVENTS = 50000;
export declare function writeTracesMeta(pkgDir: string): void;
export declare function withLocalBinPath(root: string, env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export declare function runTraces(root: string, pkg: string, env: Envelope, opts?: {
    timeoutMs?: number;
    traceDir?: string;
}): Envelope;
export declare function readTraceFile(path: string): {
    sawSession: boolean;
    events: TraceEvent[];
    errors: TraceErrorRecord[];
};
