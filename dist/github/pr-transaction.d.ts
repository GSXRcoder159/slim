/**
 * MIT License
 *
 * Cross-check PR title, body, branch, files, and labels against the accepted
 * replacement (or upstream) transaction before any git mutation.
 */
export declare const REPLACE_PR_LABELS: readonly ["slim", "slim:replace"];
export declare const UPSTREAM_PR_LABELS: readonly ["slim", "slim:upstream"];
export declare const SHA256_HEX: RegExp;
export declare const ARTIFACT_DIGEST_RE: RegExp;
export type PrKind = "replace" | "upstream";
export interface PrRequest {
    root: string;
    title: string;
    body: string;
    branch: string;
    files: string[];
    labels: string[];
    kind?: PrKind;
    pkg?: string;
    base?: string;
    artifactDigest?: string;
}
export interface RemotePrSnapshot {
    url: string;
    title: string;
    body: string;
    base: string;
    head: string;
    headSha: string;
    labels: string[];
    files: string[];
}
export { sha256Bytes, sha256File } from "../evidence/digests.ts";
export declare function withArtifactDigest(body: string, digest: string): string;
export declare function assertEvidenceBodyMatchesDisk(root: string, pkg: string, body: string): string;
export declare function assertPrMatchesTransaction(opts: PrRequest): void;
export declare function assertCommitMatchesTransaction(gitOut: (args: readonly string[]) => string, sha: string, files: string[], title: string, head: string): void;
export declare function assertRemotePrMatchesTransaction(remote: RemotePrSnapshot, accepted: {
    title: string;
    body: string;
    base: string;
    branch: string;
    sha: string;
    labels: readonly string[];
    files: string[];
}): void;
export declare function parsePullRequestNumber(url: string): number;
