/**
 * MIT License
 *
 * Emit local qualification receipts after named checkIds pass.
 */
import type { SupportInventory } from "./inventory.ts";
import { INVENTORY_NODES, INVENTORY_OS } from "./inventory.ts";
import { type CandidateIdentity } from "./receipts.ts";
export type OsCell = (typeof INVENTORY_OS)[number];
export type NodeCell = (typeof INVENTORY_NODES)[number];
export interface OsNodeCell {
    os: OsCell;
    node: NodeCell;
}
export interface CheckResult {
    ok: boolean;
    log: string;
}
export type RunCheck = (checkId: string) => CheckResult;
export interface EmitLocalOpts {
    inventory: SupportInventory;
    receiptsDir: string;
    candidate: CandidateIdentity;
    root: string;
    only?: "osNode";
    runCheck?: RunCheck;
    cell?: OsNodeCell | null;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    nodeVersion?: string;
    now?: Date;
}
export interface EmitLocalResult {
    written: string[];
    skipped: string[];
    failed: string[];
}
export declare function runnerOs(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): OsCell | null;
export declare function runnerNode(version?: string): NodeCell | null;
export declare function currentOsNodeCell(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, nodeVersion?: string): OsNodeCell | null;
export declare function defaultRunCheck(root: string, checkId: string): CheckResult;
export declare function emitLocalReceipts(opts: EmitLocalOpts): EmitLocalResult;
export declare function collectOsNodeReceipts(fromDir: string, receiptsDir: string): string[];
export declare function packAndDigest(root: string): {
    packDir: string;
    tarball: string;
    npmDigest: string;
    actionDigest: string;
    distSha256: string;
};
export declare function removePackDir(packDir: string): void;
