/**
 * MIT License
 *
 * Candidate qualification: identity, pack, local emit, optional live, inventory gate.
 */
import { type RunCheck } from "./emit-local.ts";
import { type QualifyFailure } from "./receipts.ts";
export declare const LIVE_GATES: readonly [{
    readonly env: "SLIM_LLM_LIVE";
    readonly file: "test/llm-live.test.ts";
}, {
    readonly env: "SLIM_UPSTREAM_LIVE";
    readonly file: "test/upstream-live.test.ts";
}, {
    readonly env: "SLIM_PR_LIVE";
    readonly file: "test/github/pr-live.test.ts";
}, {
    readonly env: "SLIM_ACTION_LIVE";
    readonly file: "test/github/action-live.test.ts";
}, {
    readonly env: "SLIM_RELEASE_LIVE";
    readonly file: "test/release-live.test.ts";
}];
export type QualifyMode = "emit" | "collect";
export declare function liveTestFiles(env?: NodeJS.ProcessEnv): string[];
export interface QualifyCandidateOpts {
    root: string;
    mode: QualifyMode;
    receiptsDir: string;
    commit: string;
    npmDigest?: string | null;
    actionDigest?: string | null;
    fromDir?: string;
    osNodeOnly?: boolean;
    registryUrl?: string;
    env?: NodeJS.ProcessEnv;
    runCheck?: RunCheck;
    pack?: () => {
        npmDigest: string;
        actionDigest: string;
        packDir?: string;
    };
    runLiveFiles?: (files: string[], env: NodeJS.ProcessEnv) => void;
}
export interface QualifyCandidateResult {
    failures: QualifyFailure[];
    npmDigest: string | null;
    actionDigest: string | null;
    written: string[];
}
export declare function runQualifyCandidate(opts: QualifyCandidateOpts): QualifyCandidateResult;
export declare function throwIfUnqualified(failures: QualifyFailure[]): void;
export declare function requireCommit(commit: string | undefined): string;
