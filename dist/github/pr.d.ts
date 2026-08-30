import { type ExecFileSyncOptions } from "node:child_process";
import { type SourceResult } from "../upstream/status.ts";
import { type PrKind } from "./pr-transaction.ts";
export { REPLACE_PR_LABELS, UPSTREAM_PR_LABELS } from "./pr-transaction.ts";
export interface PrResult {
    url: string | null;
    local: boolean;
}
export type ExecFileFn = (file: string, args?: readonly string[], options?: ExecFileSyncOptions) => string | Buffer;
export interface PrDeps {
    hasGh?: () => boolean;
    fetchImpl?: typeof fetch;
    env?: NodeJS.ProcessEnv;
    execFile?: ExecFileFn;
    packageRoot?: string;
}
export interface CreatePrOpts {
    root: string;
    title: string;
    body: string;
    branch: string;
    files: string[];
    labels: string[];
    kind?: PrKind;
    pkg?: string;
    artifactDigest?: string;
    base?: string;
}
export declare function parseGithubOwnerRepo(remoteUrl: string): {
    owner: string;
    repo: string;
};
export declare function slimPackageRoot(start?: string): string;
export declare function resolveArtifactDigest(opts: {
    artifactDigest?: string;
}, env: NodeJS.ProcessEnv, packageRoot?: string): string;
export declare function probeGithubAvailability(root: string, deps?: PrDeps): SourceResult<true>;
export declare function assertPrBodyComplete(body: string): void;
export declare function commitSlimBranch(opts: {
    root: string;
    branch: string;
    files: string[];
    message: string;
}, execFile: ExecFileFn): string;
export declare function maybeCreatePullRequest(requested: boolean, opts: CreatePrOpts, deps?: PrDeps): Promise<PrResult | null>;
export declare function createPullRequest(opts: CreatePrOpts, deps?: PrDeps): Promise<PrResult>;
export declare function prBodyFromEvidence(root: string, pkg: string): string;
