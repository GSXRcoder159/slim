import type { Envelope, HyrumFlags, TraceEvent } from "./types.ts";
export declare function hyrumFromTraces(traces: TraceEvent[]): Partial<HyrumFlags>;
export declare function mergeTraces(env: Envelope, traces: TraceEvent[], opts?: {
    root?: string;
}): Envelope;
