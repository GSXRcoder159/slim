/**
 * Resolve a sibling module next to the compiled or source caller.
 * Prefers `.js` (packed/dist) and falls back to `.ts` (repo source).
 */
export declare function siblingModule(metaUrl: string, relNoExt: string): string;
