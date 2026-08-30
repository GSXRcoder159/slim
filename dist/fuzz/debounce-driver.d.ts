import type { FakeClock } from "./clock.ts";
export type DebounceOp = {
    t: number;
    op: "call";
    thisArg?: unknown;
    args: unknown[];
} | {
    t: number;
    op: "cancel";
} | {
    t: number;
    op: "flush";
};
export interface DebounceScript {
    wait: number;
    options?: {
        leading?: boolean;
        trailing?: boolean;
        maxWait?: number;
    };
    events: DebounceOp[];
    /** When true, the inner spy throws on each invocation. */
    throwing?: boolean;
}
export interface SpyEvent {
    t: number;
    thisArg: unknown;
    args: unknown[];
    threw?: {
        name: string;
        message: string;
    };
}
export declare const TAXONOMY: Record<string, DebounceScript>;
export declare function runDebounceScript(debounceFn: Function, script: DebounceScript, clock: FakeClock): Promise<{
    spies: SpyEvent[];
    returns: unknown[];
    flushResults: unknown[];
}>;
/** Pick taxonomy scripts for a user envelope (observed options + default if argc===2). */
export declare function taxonomyForObserved(opts: {
    exportName: string;
    observedArgc: number[];
    optionLiterals?: unknown[];
    /** When true (Slim CI), run the full 14-script taxonomy. */
    full?: boolean;
}): DebounceScript[];
export declare function isTimerSymbol(name: string): boolean;
