export declare function standingTestPaths(root: string, pkg: string, outDir: string): {
    tsRel: string;
    jsRel: string;
    tsAbs: string;
    jsAbs: string;
};
export declare function hardeningTestPaths(root: string, moduleRel: string): {
    tsRel: string;
    jsRel: string;
    tsAbs: string;
    jsAbs: string;
};
export declare function evidenceScript(root: string): string | null;
export declare function hasStandingTests(root: string, pkg: string, outDir: string): boolean;
