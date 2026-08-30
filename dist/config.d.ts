export interface SlimConfig {
    outDir: string;
    budgetMs: number;
    testCommand: string | null;
    include: string[];
    ignore: string[];
    replacements: Record<string, {
        version: string;
        envelope: string;
        module: string;
    }>;
}
export declare const DEFAULT_CONFIG: SlimConfig;
export declare function loadConfig(projectRoot: string): SlimConfig;
