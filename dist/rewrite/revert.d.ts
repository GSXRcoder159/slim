export interface RevertRewrite {
    file: string;
    original: string;
    replacement: string;
}
export interface RevertPlan {
    package: string;
    version: string;
    module: string;
    tests: string;
    cjsCompanion: string | null;
    rewrites: RevertRewrite[];
    lockfile: "npm" | "pnpm" | "yarn" | "bun" | null;
    installCommand: string;
}
export declare function formatRevert(plan: RevertPlan): string;
export declare function applyRevert(root: string, plan: RevertPlan): void;
