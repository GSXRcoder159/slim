export type ExtractEsmOpts = {
    parentUrl?: string;
    read?: (url: string) => string | null;
    seen?: Set<string>;
    onUnresolvedStar?: (spec: string) => void;
};
export declare function extractEsmExportNames(source: string, opts?: ExtractEsmOpts): string[];
export declare function extractCjsExportNames(source: string): string[];
