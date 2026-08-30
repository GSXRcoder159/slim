import type { Envelope } from "./types.ts";
export declare function scoreSlimmable(env: Envelope, opts?: {
    usedGraphPure?: boolean;
}): Envelope["slimmable"];
export declare function applySlimmable(env: Envelope, opts?: {
    usedGraphPure?: boolean;
}): Envelope;
/** Walk used installed files (depth 8). Date.now is a seam, not impurity. */
export declare function usedSliceGraphPure(projectRoot: string, packageName: string, exportNames: string[]): boolean;
