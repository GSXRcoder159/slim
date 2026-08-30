export interface CliArgs {
    command: string;
    pkg: string | null;
    json: boolean;
    budgetMs: number | null;
    noTrace: boolean;
    noPr: boolean;
    pr: boolean;
    allowUnknown: boolean;
    force: boolean;
    out: string | null;
    dryRun: boolean;
    templateOnly: boolean;
    llm: boolean;
    keepOriginal: boolean;
    noInstall: boolean;
    allowFlaky: boolean;
    workers: number | null;
    seed: number | null;
    maxAttempts: number;
    help: boolean;
    strict: boolean;
}
export declare function parseCli(argv: string[]): CliArgs;
export declare const COMMAND_FLAGS: Record<string, ReadonlySet<string>>;
export declare function flagsPresent(argv: string[]): string[];
export declare function assertCommandFlags(command: string, flags: string[]): void;
export declare function helpText(): string;
export declare function runCli(argv: string[]): Promise<number>;
