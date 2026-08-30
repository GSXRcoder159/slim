/** Bundlephobia-ish min bytes for first-wave packages (2026-08-15). */
export declare const KNOWN_MIN_BYTES: Record<string, number>;
export interface SizeEstimate {
    minBytes: number | null;
    source: "estimated" | "measured" | "unknown" | "partial";
    unpackedBytes: number | null;
    reason: string;
}
export interface DirSize {
    bytes: number;
    complete: boolean;
    reason: string;
}
export declare function dirSize(path: string, capFiles?: number): DirSize;
export declare function estimatePackageSize(projectRoot: string, name: string, opts?: {
    capFiles?: number;
}): SizeEstimate;
export declare function gzipGuess(minBytes: number): number;
export declare function readInstalledVersion(projectRoot: string, name: string): string | null;
