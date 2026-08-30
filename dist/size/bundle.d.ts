export interface BundleDelta {
    tool: "wrangler" | "esbuild";
    bytes: number;
    entry: string;
}
export interface BundleDeps {
    hasBin?: (name: string) => boolean;
    execFile?: (file: string, args: readonly string[], opts: {
        cwd: string;
        encoding: "utf8";
        timeout?: number;
    }) => string;
    tmpDir?: () => string;
}
export declare function findBundleEntry(root: string): string | null;
/** Dry-bundle with wrangler or esbuild if on PATH. Missing tools → null. */
export declare function maybeBundleBytes(root: string, deps?: BundleDeps): BundleDelta | null;
