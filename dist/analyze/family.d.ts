export interface PackageFamily {
    name: string;
    family: string;
    subpath: string;
}
export declare function parseSpecifier(specifier: string): {
    name: string;
    subpath: string;
} | null;
export declare function resolvePackageImports(specifier: string, importMap: unknown): string | null;
export declare function resolvePackageFamily(specifier: string): PackageFamily | null;
export declare function installedVersion(deps: Record<string, string> | undefined, name: string): string;
