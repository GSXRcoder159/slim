/**
 * MIT License
 *
 * Checked-in measurement claims: freshness, schema, provenance labels.
 * The generator lives in scripts/measure-claims.ts.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertDocument } from "../schema/documents.ts";

export const MEASUREMENT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const MEASUREMENT_COMMAND = "npm run measure:claims";
export const MEASUREMENT_MAX_AGE_DAYS = 7;

export type Provenance = "measured" | "estimated" | "unavailable";

export interface ClaimValue {
  value: number | null;
  provenance: Provenance;
  reason?: string;
}

export interface MeasuredFile {
  path: string;
  sha256: string | null;
  bytes: ClaimValue;
  gzipBytes: ClaimValue;
  parseNs: ClaimValue;
}

export interface EstimatedMin {
  value: number;
  gzipBytes: number;
  provenance: "estimated";
  source: string;
}

export interface ClaimsDoc {
  schemaVersion: 1;
  command: typeof MEASUREMENT_COMMAND;
  slimVersion: string;
  node: string;
  os: string;
  date: string;
  maxAgeDays: typeof MEASUREMENT_MAX_AGE_DAYS;
  notes: string;
  files: {
    goldenLodashSlice: MeasuredFile;
    lodashOracleEntry: MeasuredFile;
    workerColdStart: MeasuredFile;
  };
  estimatedOriginalMin: Record<string, EstimatedMin>;
}

export function claimDateMs(date: string): number {
  const ms = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(ms)) throw new Error(`invalid measurements date ${date}`);
  return ms;
}

export function readCommittedClaims(root: string): ClaimsDoc {
  return JSON.parse(readFileSync(join(root, "docs/measurements.json"), "utf8")) as ClaimsDoc;
}

export function assertClaimsFresh(committed: ClaimsDoc, now = new Date()): void {
  assertDocument("measurements", committed);
  if (committed.schemaVersion !== 1) throw new Error("stale measurements schemaVersion");
  const age = now.getTime() - claimDateMs(committed.date);
  if (age > MEASUREMENT_MAX_AGE_MS) {
    throw new Error(`measurements date ${committed.date} is older than freshness window`);
  }
}

export function qualifyMeasurementClaims(root: string, now = new Date()): void {
  assertClaimsFresh(readCommittedClaims(root), now);
}
