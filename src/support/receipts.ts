/**
 * MIT License
 *
 * Qualification receipts: schema, identity, forbidden payload, inventory coverage.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertDocument } from "../schema/documents.ts";
import type { InventoryEntry, SupportInventory } from "./inventory.ts";

export const RECEIPT_OUTCOMES = [
  "pass",
  "fail",
  "refused",
  "blocked",
  "unavailable",
  "not-observed",
  "not-verified",
] as const;

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
}

export interface CandidateIdentity {
  commit: string;
  npmDigest: string | null;
  actionDigest: string | null;
  workflowRun?: string | null;
}

const FORBIDDEN_KEYS = new Set([
  "prompt",
  "prompts",
  "secret",
  "secrets",
  "apiKey",
  "api_key",
  "token",
  "rawTrace",
  "traces",
  "oracleSource",
  "oracle",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
]);

export function receiptFileName(entryId: string): string {
  return `${entryId.replaceAll("/", "--")}.json`;
}

export function writeReceipt(dir: string, entryId: string, receipt: unknown): string {
  parseReceipt(receipt);
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, receiptFileName(entryId));
  writeFileSync(dest, JSON.stringify(receipt, null, 2) + "\n");
  return dest;
}

export function providerReceipt(opts: {
  provider: "anthropic" | "openai";
  model: string;
  fixture: string;
  commit: string;
  npmDigest: string | null;
  startedAt: Date;
  endedAt: Date;
  log: string;
  workflowRun?: string | null;
}): QualificationReceipt {
  return {
    schemaVersion: 1,
    checkId: "test/llm-live.test.ts",
    command: "replace",
    fixture: opts.fixture,
    environment: `${process.platform} node-${process.version} model=${opts.model}`,
    provider: opts.provider,
    service: null,
    startedAt: opts.startedAt.toISOString(),
    endedAt: opts.endedAt.toISOString(),
    outcome: "pass",
    commit: opts.commit,
    npmDigest: opts.npmDigest,
    actionDigest: null,
    workflowRun: opts.workflowRun ?? null,
    logDigest: createHash("sha256").update(opts.log).digest("hex"),
  };
}

export function forbiddenKey(value: unknown, path = ""): string | null {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = forbiddenKey(value[i], `${path}/${i}`);
      if (hit) return hit;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(key)) return path ? `${path}/${key}` : key;
    const hit = forbiddenKey(child, path ? `${path}/${key}` : key);
    if (hit) return hit;
  }
  return null;
}

export function parseReceipt(raw: unknown): QualificationReceipt {
  const banned = forbiddenKey(raw);
  if (banned) {
    throw new Error(`receipt contains forbidden field ${banned}`);
  }
  assertDocument("receipt", raw);
  const receipt = raw as QualificationReceipt;
  if (!/^[0-9a-f]{40}$/.test(receipt.commit)) {
    throw new Error("receipt commit is not 40-char hex");
  }
  if (!/^[0-9a-f]{64}$/.test(receipt.logDigest)) {
    throw new Error("receipt logDigest is not sha256 hex");
  }
  if (receipt.npmDigest && !/^[0-9a-f]{64}$/.test(receipt.npmDigest)) {
    throw new Error("receipt npmDigest is not sha256 hex");
  }
  if (receipt.actionDigest && !/^[0-9a-f]{64}$/.test(receipt.actionDigest)) {
    throw new Error("receipt actionDigest is not sha256 hex");
  }
  return receipt;
}

export function identityMismatch(
  receipt: QualificationReceipt,
  candidate: CandidateIdentity,
  entry: InventoryEntry,
): string | null {
  if (receipt.checkId !== entry.checkId) {
    return `checkId ${receipt.checkId} != ${entry.checkId}`;
  }
  if (receipt.commit !== candidate.commit) {
    return `stale commit ${receipt.commit} != ${candidate.commit}`;
  }
  if (receipt.fixture === "") {
    return "missing fixture identity";
  }
  if (entry.kind === "provider" && receipt.provider !== entry.name) {
    return `provider ${receipt.provider} != ${entry.name}`;
  }
  if (entry.kind === "externalService" && receipt.service !== entry.name) {
    return `service ${receipt.service} != ${entry.name}`;
  }
  if (entry.kind === "action") {
    if (!candidate.actionDigest || receipt.actionDigest !== candidate.actionDigest) {
      return `action digest mismatch`;
    }
  } else if (candidate.npmDigest && receipt.npmDigest !== candidate.npmDigest) {
    return `npm digest mismatch`;
  }
  if (candidate.workflowRun !== undefined && candidate.workflowRun !== null) {
    if (receipt.workflowRun !== candidate.workflowRun) {
      return `workflow run mismatch`;
    }
  }
  return null;
}

function timestampIssue(receipt: QualificationReceipt, now: Date): string | null {
  const start = Date.parse(receipt.startedAt);
  const end = Date.parse(receipt.endedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return "invalid timestamp";
  if (start > end) return "startedAt after endedAt";
  if (end > now.getTime() + 60_000) return "endedAt in the future";
  return null;
}

export interface QualifyFailure {
  entryId: string;
  reason: string;
}

export function qualifyInventory(
  inventory: SupportInventory,
  receiptsDir: string,
  candidate: CandidateIdentity,
  opts: { now?: Date } = {},
): QualifyFailure[] {
  const now = opts.now ?? new Date();
  const failures: QualifyFailure[] = [];
  const files = existsSync(receiptsDir)
    ? new Map(
        readdirSync(receiptsDir)
          .filter((n) => n.endsWith(".json"))
          .map((n) => [n, join(receiptsDir, n)] as const),
      )
    : new Map<string, string>();

  for (const entry of inventory.entries) {
    const file = files.get(receiptFileName(entry.id));
    if (!file) {
      failures.push({ entryId: entry.id, reason: "missing receipt" });
      continue;
    }
    let receipt: QualificationReceipt;
    try {
      receipt = parseReceipt(JSON.parse(readFileSync(file, "utf8")));
    } catch (err) {
      failures.push({
        entryId: entry.id,
        reason: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    const mismatch = identityMismatch(receipt, candidate, entry);
    if (mismatch) {
      failures.push({ entryId: entry.id, reason: mismatch });
      continue;
    }
    const time = timestampIssue(receipt, now);
    if (time) {
      failures.push({ entryId: entry.id, reason: time });
      continue;
    }
    if (receipt.outcome !== "pass") {
      failures.push({ entryId: entry.id, reason: `outcome ${receipt.outcome} is not pass` });
    }
  }
  return failures;
}
