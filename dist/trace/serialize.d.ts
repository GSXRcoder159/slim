import type { SlimValue, TraceEvent } from "../envelope/types.ts";
export declare function serialize(value: unknown, opts?: {
    budget?: number;
}): SlimValue;
export declare function deserialize(v: SlimValue): unknown;
export declare function snapshot(args: unknown[]): SlimValue[];
export declare function serializeEvent(input: {
    args: unknown[];
    thisArg?: unknown;
    result?: unknown;
}): Pick<TraceEvent, "args" | "thisArg" | "result" | "truncated">;
export declare function deserializeEvent(e: {
    args: SlimValue[];
    thisArg?: SlimValue;
    result?: SlimValue;
}): {
    args: unknown[];
    thisArg?: unknown;
    result?: unknown;
};
export declare function mutatedArgIndexes(before: SlimValue[], after: SlimValue[]): number[];
export declare function createWalker(budget?: number): {
    value(v: unknown): SlimValue;
    readonly truncated: boolean;
};
