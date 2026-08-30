import type { CliArgs } from "./cli.ts";
export declare const CJS_HOOKS_LINE = "cjs hooks      recommend Node >= 22.22.3 (documented CJS sync-hook fixes)";
export interface DoctorReport {
    node: string;
    nodeOk: boolean;
    registerHooks: boolean;
    gh: boolean;
    typescript: boolean;
    git: boolean;
    dirtyTree: boolean;
    lockfile: string | null;
    issues: string[];
}
export declare function collectDoctor(cwd?: string, opts?: {
    porcelain?: string;
}): DoctorReport;
export declare function doctorExitCode(report: DoctorReport, strict: boolean): number;
export declare function runDoctor(args: CliArgs): Promise<number>;
