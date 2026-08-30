import { vitestTraceConfigSource } from "./vitest.ts";
export { vitestTraceConfigSource };
export type RunnerKind = "node:test" | "vitest" | "jest" | "none";
export interface DetectedRunner {
    kind: RunnerKind;
    command: string | null;
    jestSnippet?: string;
}
export declare function detectRunner(projectRoot: string): DetectedRunner;
export declare function traceEnv(packages: string[], outPath: string, root?: string): NodeJS.ProcessEnv;
export declare function nodeTestPreloadArgs(hookModuleAbsPath: string): string[];
export declare function findVitestUserConfig(root: string): string | null;
export declare function writeVitestTraceConfig(root: string, packages: string[], configDir?: string): string;
export declare function buildTraceSpawn(runner: DetectedRunner, opts: {
    hookPath: string;
    vitestConfigPath?: string;
}): {
    file: string;
    args: string[];
} | null;
