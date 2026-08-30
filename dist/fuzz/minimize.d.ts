/**
 * Delta-debug a disagreeing argument list. `pred` is true while the pair still
 * disagrees. Stops at `deadlineMs` (caller typically passes 2000).
 */
export declare function minimize(args: unknown[], pred: (a: unknown[]) => boolean, deadlineMs: number): unknown[];
