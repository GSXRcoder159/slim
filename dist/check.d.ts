import { type SpawnSyncOptions, type SpawnSyncReturns } from "node:child_process";
import type { CliArgs } from "./cli.ts";
import { JSON_SCHEMA_VERSION, statusFromExit } from "./json.ts";
import { type EnvelopeDrift } from "./envelope/drift.ts";
export { evidenceScript, hardeningTestPaths, standingTestPaths } from "./evidence/paths.ts";
export type CheckSpawn = (command: string, args?: readonly string[], options?: SpawnSyncOptions) => Pick<SpawnSyncReturns<string | Buffer>, "status" | "signal" | "error"> & {
    stdout?: string | Buffer | null;
    stderr?: string | Buffer | null;
};
export interface RunCheckOpts {
    cwd?: string;
    spawn?: CheckSpawn;
}
export interface CheckPackageResult {
    pkg: string;
    ok: boolean;
    drift: EnvelopeDrift[];
    unknowns: string[];
    standing: "pass" | "fail" | "missing";
    residualRisk: string[];
}
export interface CheckReport {
    schemaVersion: typeof JSON_SCHEMA_VERSION;
    ok: boolean;
    exit: number;
    status: ReturnType<typeof statusFromExit>;
    packages: CheckPackageResult[];
}
export declare const DEFAULT_CHECK_CHILD_TIMEOUT_MS = 600000;
export declare function checkChildTimeoutMs(env?: NodeJS.ProcessEnv): number;
export declare function runStandingTests(root: string, pkg: string, outDir: string, spawn?: CheckSpawn, json?: boolean): void;
export declare function runHardenedTests(root: string, moduleRel: string | undefined, spawn?: CheckSpawn, json?: boolean): void;
export declare function runConfiguredTestCommand(root: string, testCommand: string | null, spawn?: CheckSpawn, json?: boolean): void;
export declare function runCheck(args: CliArgs, opts?: RunCheckOpts): Promise<number>;
