/** Line-oriented removal of a dependency key; preserves indent and sibling keys. */
export declare function removeDependencyKey(packageJsonText: string, depName: string): {
    text: string;
    removed: boolean;
};
export declare function restoreDependencyKey(packageJsonText: string, depName: string, version: string): string;
export declare function rewritePackageJson(path: string, depName: string): boolean;
