/**
 * MIT License
 *
 * Release gate: identity, artifact digests, qualify, tarball publish, tag attach.
 */
import { type ExecFileSyncOptions } from "node:child_process";
import { type AttachResult } from "./attach.ts";
export type GateMode = "identity" | "artifacts" | "rehearse" | "publish";
export type ExecFileFn = (file: string, args?: readonly string[], options?: ExecFileSyncOptions) => string | Buffer;
export interface ArtifactIdentity {
    npmDigest: string;
    actionDigest: string;
}
export interface GateOpts {
    root: string;
    mode: GateMode;
    tag?: string;
    tarball?: string;
    receiptsDir?: string;
    commit?: string;
    workflowRun?: string | null;
    registryUrl?: string;
    parentSha?: string;
    remote?: string;
    deleteTarball?: boolean;
}
export interface GateResult {
    version: string;
    tag: string;
    floatingTag: string;
    npmDigest: string | null;
    actionDigest: string | null;
    attached: AttachResult | null;
}
export declare function resolveTag(root: string, tag?: string): string;
export declare function assertIdentity(root: string, tag: string, registryUrl?: string): void;
export declare function assertTarballMatchesRoot(tarball: string, root: string): ArtifactIdentity;
export declare function npmPublishArgs(tarball: string, opts: {
    dryRun: boolean;
    provenance: boolean;
}): string[];
/** npm 11 fail-closes dry-run when the version is already on the registry. Packing still succeeded. */
export declare function isDryRunVersionConflict(msg: string): boolean;
export declare function npmPublishTarball(tarball: string, opts: {
    dryRun: boolean;
    provenance: boolean;
    cwd: string;
    env?: NodeJS.ProcessEnv;
}, execFile?: ExecFileFn): void;
export declare function runReleaseGate(opts: GateOpts, execFile?: ExecFileFn): GateResult;
