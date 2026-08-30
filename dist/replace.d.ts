import type { CliArgs } from "./cli.ts";
import type { TraceEvent } from "./envelope/types.ts";
import { withLocalBinPath, writeTracesMeta } from "./trace/run.ts";
export { withLocalBinPath, writeTracesMeta };
export declare function runReplace(args: CliArgs): Promise<number>;
export declare function shouldRunMergeGate(opts: {
    dryRun: boolean;
}): boolean;
export declare function runMergeGate(root: string, testCommand: string | null, json?: boolean): void;
export declare function assertNoPollutionDependence(traces: TraceEvent[]): void;
