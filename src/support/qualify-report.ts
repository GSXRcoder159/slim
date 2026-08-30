/**
 * MIT License
 *
 * Machine-valid qualification handoff report for one candidate.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { EXIT_FAIL, SlimExit } from "../exit.ts";
import { EXPECTED_DEFAULT_BRANCH, EXPECTED_GITHUB_REPO } from "../release/identity.ts";
import { assertDocument } from "../schema/documents.ts";
import type { QualifyFailure } from "./receipts.ts";

export const QUALIFY_REPORT_NAME = "qualify-report.json";

export interface QualifyReport {
  schemaVersion: 1;
  commit: string;
  npmDigest: string;
  actionDigest: string;
  workflowRun: string;
  branch: string;
  repository: string;
  generatedAt: string;
  entryCount: number;
  failures: QualifyFailure[];
  outcome: "pass" | "fail";
  summary: string;
}

export function qualifyReportPath(receiptsDir: string): string {
  return join(dirname(receiptsDir), QUALIFY_REPORT_NAME);
}

export function qualifyReport(opts: {
  commit: string;
  npmDigest: string;
  actionDigest: string;
  workflowRun: string;
  branch?: string;
  repository?: string;
  generatedAt?: Date;
  entryCount: number;
  failures: QualifyFailure[];
}): QualifyReport {
  if (!opts.workflowRun) {
    throw new SlimExit(EXIT_FAIL, "qualify-report: workflowRun is required");
  }
  const outcome = opts.failures.length === 0 ? "pass" : "fail";
  const summary =
    outcome === "pass"
      ? `Candidate ${opts.commit} passed ${opts.entryCount} support-inventory receipts (workflowRun ${opts.workflowRun}).`
      : `Candidate ${opts.commit} failed ${opts.failures.length} of ${opts.entryCount} receipts (workflowRun ${opts.workflowRun}).`;
  const doc: QualifyReport = {
    schemaVersion: 1,
    commit: opts.commit,
    npmDigest: opts.npmDigest,
    actionDigest: opts.actionDigest,
    workflowRun: opts.workflowRun,
    branch: opts.branch ?? EXPECTED_DEFAULT_BRANCH,
    repository: opts.repository ?? EXPECTED_GITHUB_REPO,
    generatedAt: (opts.generatedAt ?? new Date()).toISOString(),
    entryCount: opts.entryCount,
    failures: opts.failures.map((f) => ({ entryId: f.entryId, reason: f.reason })),
    outcome,
    summary,
  };
  assertDocument("qualifyReport", doc);
  return doc;
}

export function writeQualifyReport(dirOrFile: string, report: QualifyReport): string {
  assertDocument("qualifyReport", report);
  const dest = dirOrFile.endsWith(".json") ? dirOrFile : join(dirOrFile, QUALIFY_REPORT_NAME);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, JSON.stringify(report, null, 2) + "\n");
  return dest;
}
