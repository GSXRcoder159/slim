export interface SpliceEdit {
    start: number;
    end: number;
    text: string;
}
/** Position splice. Untouched bytes stay identical. */
export declare function applySplices(source: string, edits: SpliceEdit[]): string;
/** Named catalog export for a per-method specifier (`lodash/get`, `lodash.get`). */
export declare function methodExportName(specifier: string): string | null;
export declare function rewriteSpecifiers(ts: typeof import("typescript"), source: string, fileName: string, fromSpecifiers: Set<string>, toSpecifier: string): {
    text: string;
    changed: boolean;
};
export declare function rewriteProjectImports(projectRoot: string, files: string[], fromSpecifiers: Set<string>, toSpecifier: string): string[];
