import type { ArgShape, SlimValue, TraceEvent } from "../envelope/types.ts";
export interface Gen {
    next(): number;
    int(min: number, max: number): number;
    pick<T>(xs: T[]): T;
    bool(): boolean;
}
/** mulberry32 — deterministic, 32-bit. */
export declare function createGen(seed: number): Gen;
export declare function fromTraces(traces: TraceEvent[], _gen: Gen): unknown[][];
export declare function mutateArgs(args: unknown[], gen: Gen): unknown[];
export declare function fromShapes(shapes: ArgShape[], gen: Gen, argc?: number): unknown[];
/** Result-member / returned-function traces are not top-level export calls. */
export declare function isExportTrace(tr: TraceEvent): boolean;
export declare function pickObservedArgc(observed: number[], gen: Gen, fallback?: number): number;
export declare function junkArgs(argc: number, gen: Gen): unknown[];
export declare function enumerateLiteralUnions(shapes: ArgShape[], cap: number): unknown[][];
export declare function hydrate(value: SlimValue, _refs?: Map<number, unknown>): unknown;
