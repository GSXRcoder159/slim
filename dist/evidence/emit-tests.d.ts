import type { Envelope, TraceEvent } from "../envelope/types.ts";
export declare function emitStandingTests(opts: {
    root: string;
    outDir: string;
    pkg: string;
    env: Envelope;
    traces: TraceEvent[];
    runner: "node:test" | "vitest";
    moduleSpecifier: string;
}): string;
export declare function emitHardenedGetSetTest(opts: {
    root: string;
    moduleRel: string;
    runner?: "node:test" | "vitest";
}): string;
