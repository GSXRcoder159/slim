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
import { repoRootFromSupport } from "./inventory.ts";
import { ADVERTISED_ACTION_TAG, advertisedActionUses } from "../release/identity.ts";
import { qualifyMeasurementClaims } from "./measurements.ts";

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
export const RECEIPT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const LIVE_FIXTURES: Record<string, readonly string[]> = {
  "test/llm-live.test.ts": ["tiny-add"],
  "test/upstream-live.test.ts": ["request-watch"],
  "test/github/pr-live.test.ts": ["ms"],
  "test/release-live.test.ts": ["release-rehearse"],
  "test/github/action-live.test.ts": ["packed-action-consumer"],
};

export function allowedFixtures(entry: InventoryEntry): ReadonlySet<string> {
  if (entry.receiptClass === "live") {
    return new Set(LIVE_FIXTURES[entry.checkId] ?? []);
  }
  return new Set([entry.checkId]);
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

export function githubReceipt(opts: {
  fixture: string;
  commit: string;
  npmDigest: string | null;
  startedAt: Date;
  endedAt: Date;
  log: string;
  workflowRun?: string | null;
  prUrl?: string;
  cleanup?: string;
}): QualificationReceipt {
  const envBits = [`${process.platform} node-${process.version}`];
  if (opts.prUrl) envBits.push(`pr=${opts.prUrl}`);
  if (opts.cleanup) envBits.push(`cleanup=${opts.cleanup}`);
  return {
    schemaVersion: 1,
    checkId: "test/github/pr-live.test.ts",
    command: "replace",
    fixture: opts.fixture,
    environment: envBits.join(" "),
    provider: null,
    service: "github",
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

export function sourceReceipt(opts: {
  service: "osv" | "npm-registry";
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
    checkId: "test/upstream-live.test.ts",
    command: "upstream",
    fixture: opts.fixture,
    environment: `${process.platform} node-${process.version}`,
    provider: null,
    service: opts.service,
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

export function releaseReceipt(opts: {
  fixture: string;
  commit: string;
  npmDigest: string;
  actionDigest: string;
  startedAt: Date;
  endedAt: Date;
  log: string;
  workflowRun?: string | null;
  version?: string;
  publication?: "dry-run" | "published";
  rollback?: "none" | "restored" | "tags-not-pushed";
}): QualificationReceipt {
  const version = opts.version ?? "0.1.0";
  const publication = opts.publication ?? "dry-run";
  const rollback = opts.rollback ?? "restored";
  return {
    schemaVersion: 1,
    checkId: "test/release-live.test.ts",
    command: null,
    fixture: opts.fixture,
    environment: `${process.platform} node-${process.version} version=${version} publication=${publication} rollback=${rollback} npmDigest=${opts.npmDigest} actionDigest=${opts.actionDigest}`,
    provider: null,
    service: "npm-publish",
    startedAt: opts.startedAt.toISOString(),
    endedAt: opts.endedAt.toISOString(),
    outcome: "pass",
    commit: opts.commit,
    npmDigest: opts.npmDigest,
    actionDigest: opts.actionDigest,
    workflowRun: opts.workflowRun ?? null,
    logDigest: createHash("sha256").update(opts.log).digest("hex"),
  };
}

export function localReceipt(opts: {
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
}): QualificationReceipt {
  return {
    schemaVersion: 1,
    checkId: opts.entry.checkId,
    command: opts.entry.command ?? null,
    fixture: opts.fixture ?? opts.entry.checkId,
    environment: opts.environment,
    provider: null,
    service: null,
    startedAt: opts.startedAt.toISOString(),
    endedAt: opts.endedAt.toISOString(),
    outcome: "pass",
    commit: opts.commit,
    npmDigest: opts.npmDigest,
    actionDigest: opts.actionDigest,
    workflowRun: opts.workflowRun ?? null,
    logDigest: createHash("sha256").update(opts.log).digest("hex"),
  };
}

export function actionReceipt(opts: {
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
}): QualificationReceipt {
  const cells =
    opts.cells ??
    "ubuntu-latest/22.18,ubuntu-latest/24,macos-latest/22.18,macos-latest/24,windows-latest/22.18,windows-latest/24";
  return {
    schemaVersion: 1,
    checkId: "test/github/action-live.test.ts",
    command: opts.command,
    fixture: opts.fixture,
    environment: `repo=${opts.repository} ref=${opts.ref} uses=${advertisedActionUses(opts.command)} cells=${cells}`,
    provider: null,
    service: null,
    startedAt: opts.startedAt.toISOString(),
    endedAt: opts.endedAt.toISOString(),
    outcome: "pass",
    commit: opts.commit,
    npmDigest: null,
    actionDigest: opts.actionDigest,
    workflowRun: opts.workflowRun ?? null,
    logDigest: createHash("sha256").update(opts.log).digest("hex"),
    repository: opts.repository,
    ref: opts.ref,
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

function requiresNpmDigest(entry: InventoryEntry): boolean {
  return entry.kind !== "action";
}

function requiresActionDigest(entry: InventoryEntry): boolean {
  return entry.kind === "action" || entry.name === "npm-publish";
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
  if (!allowedFixtures(entry).has(receipt.fixture)) {
    return `unknown fixture ${receipt.fixture}`;
  }
  if (!receipt.environment) {
    return "missing environment";
  }
  if (
    (entry.kind === "command" || entry.kind === "jsonCommand") &&
    receipt.command !== entry.command
  ) {
    return `command ${receipt.command} != ${entry.command}`;
  }
  if (entry.kind === "action" && receipt.command !== entry.name) {
    return `command ${receipt.command} != ${entry.name}`;
  }
  if (entry.kind === "action") {
    if (!receipt.repository) return "missing repository";
    if (!/^[^/\s]+\/[^/\s]+$/.test(receipt.repository)) return "repository mismatch";
    if (!receipt.ref) return "missing ref";
    if (receipt.ref !== `refs/tags/${ADVERTISED_ACTION_TAG}`) return "ref mismatch";
    if (!receipt.environment.includes("cells=")) return "missing cells";
  }
  if (entry.kind === "osNode") {
    const env = receipt.environment;
    if (!entry.os || !env.includes(entry.os)) {
      return `osNode environment missing ${entry.os}`;
    }
    if (!entry.node || !env.includes(entry.node)) {
      return `osNode environment missing ${entry.node}`;
    }
  }
  if (entry.kind === "packageManager") {
    const env = receipt.environment;
    if (!entry.name || !env.includes(entry.name)) {
      return `packageManager environment missing ${entry.name}`;
    }
  }
  if (entry.kind === "provider" && receipt.provider !== entry.name) {
    return `provider ${receipt.provider} != ${entry.name}`;
  }
  if (entry.kind === "externalService" && receipt.service !== entry.name) {
    return `service ${receipt.service} != ${entry.name}`;
  }
  if (requiresActionDigest(entry)) {
    if (!candidate.actionDigest) return "missing action digest";
    if (receipt.actionDigest !== candidate.actionDigest) return "action digest mismatch";
  }
  if (requiresNpmDigest(entry)) {
    if (!candidate.npmDigest) return "missing npm digest";
    if (receipt.npmDigest !== candidate.npmDigest) return "npm digest mismatch";
  }
  if (entry.receiptClass === "live") {
    if (!candidate.workflowRun || !receipt.workflowRun) return "missing workflow run";
    if (receipt.workflowRun !== candidate.workflowRun) return "workflow run mismatch";
  } else if (candidate.workflowRun && receipt.workflowRun !== candidate.workflowRun) {
    return "workflow run mismatch";
  }
  return null;
}

function timestampIssue(receipt: QualificationReceipt, now: Date): string | null {
  const start = Date.parse(receipt.startedAt);
  const end = Date.parse(receipt.endedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return "invalid timestamp";
  if (start > end) return "startedAt after endedAt";
  if (end > now.getTime() + 60_000) return "endedAt in the future";
  if (now.getTime() - end > RECEIPT_MAX_AGE_MS) return "endedAt older than freshness window";
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
  opts: { now?: Date; root?: string } = {},
): QualifyFailure[] {
  const now = opts.now ?? new Date();
  const root = opts.root ?? repoRootFromSupport();
  const failures: QualifyFailure[] = [];
  const files = existsSync(receiptsDir)
    ? new Map(
        readdirSync(receiptsDir)
          .filter((n) => n.endsWith(".json"))
          .map((n) => [n, join(receiptsDir, n)] as const),
      )
    : new Map<string, string>();

  for (const entry of inventory.entries) {
    if (entry.kind === "measurement") {
      try {
        qualifyMeasurementClaims(root, now);
      } catch (err) {
        failures.push({
          entryId: entry.id,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
      continue;
    }
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
