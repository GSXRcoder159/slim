import type { CliArgs } from "./cli.ts";
import { type UpstreamDeps } from "./upstream/fix.ts";
import { type SourceStatus } from "./upstream/status.ts";
export type { UpstreamDeps, UpstreamFinding, UpstreamOracle } from "./upstream/fix.ts";
export { applyUpstreamFix } from "./upstream/fix.ts";
export type UpstreamConclusion = "exposed" | "not-exposed" | "unmapped" | "routine-release" | "source-unavailable" | "oracle-unavailable" | "incomplete-state" | "missing-state" | "malformed-state" | "regeneration-failure" | "no-replacements";
export type UpstreamAction = "none" | "blocked" | "review" | "regenerated";
export interface SourceReport {
    status: SourceStatus;
    detail: string;
}
export declare function runUpstream(args: CliArgs, deps?: UpstreamDeps): Promise<number>;
