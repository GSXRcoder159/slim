export interface Project {
    root: string;
    packageJsonPath: string;
    packageJson: PackageJson;
    lockfile: "npm" | "pnpm" | "yarn" | "bun" | null;
    tsconfigPath: string | null;
    srcDir: string;
}
export interface PackageJson {
    name?: string;
    version?: string;
    type?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
    imports?: Record<string, string | Record<string, string>>;
    [key: string]: unknown;
}
export declare function findProjectRoot(start?: string): string;
export declare function detectLockfile(root: string): Project["lockfile"];
export declare function loadProject(start?: string): Project;
export declare function loadTargetTypescript(projectRoot: string): typeof import("typescript");
export declare function walkSourceFiles(dir: string, ignore?: Set<string>): string[];
/** Path-substring include/ignore on repo-relative paths. No glob library. */
export declare function filterSourceFiles(files: string[], root: string, opts?: {
    include?: string[];
    ignore?: string[];
}): string[];
export declare function fileUrl(abs: string): string;
export declare function isDir(p: string): boolean;
