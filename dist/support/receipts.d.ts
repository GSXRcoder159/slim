/**
 * MIT License
 *
 * Qualification receipts: schema, identity, forbidden payload, inventory coverage.
 */
import type { InventoryEntry, SupportInventory } from "./inventory.ts";
export declare const RECEIPT_OUTCOMES: readonly ["pass", "fail", "refused", "blocked", "unavailable", "not-observed", "not-verified"];
export type ReceiptOutcome = (typeof RECEIPT_OUTCOMES)[number];
export interface QualificationReceipt {
    schemaVersion: 1;
    checkId: string;
    command: string | null;
    fixture: string;
    environment: string | null;
    provider: string | null;
    service: string | null;
    startedAt: string;
    endedAt: string;
    outcome: ReceiptOutcome;
    commit: string;
    npmDigest: string | null;
    actionDigest: string | null;
    workflowRun: string | null;
    logDigest: string;
    repository?: string | null;
    ref?: string | null;
}
export interface CandidateIdentity {
    commit: string;
    npmDigest: string | null;
    actionDigest: string | null;
    workflowRun?: string | null;
}
/** Qualification receipts older than this are stale. */
export declare const RECEIPT_MAX_AGE_MS: number;
export declare function allowedFixtures(entry: InventoryEntry): ReadonlySet<string>;
export declare function receiptFileName(entryId: string): string;
export declare function writeReceipt(dir: string, entryId: string, receipt: unknown): string;
export declare function providerReceipt(opts: {
    provider: "anthropic" | "openai";
    model: string;
    fixture: string;
    commit: string;
    npmDigest: string | null;
    startedAt: Date;
    endedAt: Date;
    log: string;
    workflowRun?: string | null;
}): QualificationReceipt;
export declare function githubReceipt(opts: {
    fixture: string;
    commit: string;
    npmDigest: string | null;
    startedAt: Date;
    endedAt: Date;
    log: string;
    workflowRun?: string | null;
    prUrl?: string;
    cleanup?: string;
}): QualificationReceipt;
export declare function sourceReceipt(opts: {
    service: "osv" | "npm-registry";
    fixture: string;
    commit: string;
    npmDigest: string | null;
    startedAt: Date;
    endedAt: Date;
    log: string;
    workflowRun?: string | null;
}): QualificationReceipt;
export declare function releaseReceipt(opts: {
    fixture: string;
    commit: string;
    npmDigest: string;
    actionDigest: string;
    startedAt: Date;
    endedAt: Date;
    log: string;
    workflowRun?: string | null;
}): QualificationReceipt;
export declare function localReceipt(opts: {
    entry: InventoryEntry;
    commit: string;
    npmDigest: string | null;
    actionDigest: string | null;
    startedAt: Date;
    endedAt: Date;
    log: string;
    environment: string;
    fixture?: string;
    workflowRun?: string | null;
}): QualificationReceipt;
export declare function actionReceipt(opts: {
    command: "check" | "bloat" | "upstream";
    fixture: string;
    commit: string;
    actionDigest: string;
    startedAt: Date;
    endedAt: Date;
    log: string;
    workflowRun?: string | null;
    repository: string;
    ref: string;
    cells?: string;
}): QualificationReceipt;
export declare function forbiddenKey(value: unknown, path?: string): string | null;
export declare function parseReceipt(raw: unknown): QualificationReceipt;
export declare function identityMismatch(receipt: QualificationReceipt, candidate: CandidateIdentity, entry: InventoryEntry): string | null;
export interface QualifyFailure {
    entryId: string;
    reason: string;
}
export declare function qualifyInventory(inventory: SupportInventory, receiptsDir: string, candidate: CandidateIdentity, opts?: {
    now?: Date;
}): QualifyFailure[];
