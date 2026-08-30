/**
 * MIT License
 *
 * Attach the extracted npm pack as a child commit and move release tags onto it.
 */
import { type ExecFileSyncOptions } from "node:child_process";
export type ExecFileFn = (file: string, args?: readonly string[], options?: ExecFileSyncOptions) => string | Buffer;
export interface AttachResult {
    commit: string;
    versionTag: string;
    floatingTag: string;
    previousVersionSha: string | null;
    previousFloatingSha: string | null;
}
export interface AttachOpts {
    gitRoot: string;
    packRoot: string;
    parentSha: string;
    versionTag: string;
    floatingTag: string;
    push?: boolean;
    remote?: string;
    message?: string;
}
export declare function attachCompiledTree(opts: AttachOpts, execFile?: ExecFileFn): AttachResult;
export declare function rollbackAttach(attached: AttachResult, gitRoot: string, execFile?: ExecFileFn): void;
