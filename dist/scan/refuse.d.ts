/** Known fat / Edge-hostile packages and honest v1 refusals. */
export type RefuseReason = {
    pkg: string;
    why: string;
    evidence: string;
    whatToDo: string;
};
export declare function refusePackage(name: string, installedDir?: string | null): RefuseReason | null;
export declare function formatRefuse(r: RefuseReason): string;
/** Fat / Edge-hostile packages that slim-bloat flags when added without a replacement. */
export declare const BLOAT_PACKAGES: Set<string>;
