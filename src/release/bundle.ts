/**
 * MIT License
 *
 * Qualification bundle: identity document, one tarball, gitignored receipts.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, cpSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { EXIT_FAIL, EXIT_REFUSED, SlimExit } from "../exit.ts";
import { assertDocument, readDocument } from "../schema/documents.ts";
import { RECEIPT_MAX_AGE_MS } from "../support/receipts.ts";
import { QUALIFY_REPORT_NAME, type QualifyReport } from "../support/qualify-report.ts";
import { artifactIdentity, type ArtifactIdentity } from "./digest.ts";

export interface QualifyBundle {
  dir: string;
  identity: ArtifactIdentity;
  tarball: string;
  receiptsDir: string;
  report?: QualifyReport;
}

export function writeQualifyBundle(opts: {
  dir: string;
  tarball: string;
  receiptsDir: string;
  commit: string;
  npmDigest: string;
  actionDigest: string;
  distSha256: string;
  packedAt?: string;
  report?: QualifyReport;
  reportPath?: string;
}): QualifyBundle {
  mkdirSync(opts.dir, { recursive: true });
  const receiptsDir = join(opts.dir, "receipts");
  mkdirSync(receiptsDir, { recursive: true });
  const destTar = join(opts.dir, tarballBase(opts.tarball));
  if (opts.tarball !== destTar) cpSync(opts.tarball, destTar);
  if (existsSync(opts.receiptsDir)) {
    for (const name of readdirSync(opts.receiptsDir)) {
      if (!name.endsWith(".json") || name === QUALIFY_REPORT_NAME) continue;
      const src = join(opts.receiptsDir, name);
      if (!statSync(src).isFile()) continue;
      cpSync(src, join(receiptsDir, name));
    }
  }
  const identity = artifactIdentity({
    commit: opts.commit,
    npmDigest: opts.npmDigest,
    actionDigest: opts.actionDigest,
    distSha256: opts.distSha256,
    packedAt: opts.packedAt,
  });
  assertDocument("artifactIdentity", identity);
  writeFileSync(join(opts.dir, "artifact-identity.json"), JSON.stringify(identity, null, 2) + "\n");
  const sibling = join(dirname(opts.receiptsDir), QUALIFY_REPORT_NAME);
  const reportSrc = opts.reportPath ?? (existsSync(sibling) ? sibling : undefined);
  let report: QualifyReport | undefined = opts.report;
  if (report) {
    writeFileSync(join(opts.dir, QUALIFY_REPORT_NAME), JSON.stringify(report, null, 2) + "\n");
  } else if (reportSrc && existsSync(reportSrc)) {
    cpSync(reportSrc, join(opts.dir, QUALIFY_REPORT_NAME));
    report = readDocument("qualifyReport", join(opts.dir, QUALIFY_REPORT_NAME)) as QualifyReport;
  }
  return { dir: opts.dir, identity, tarball: destTar, receiptsDir, report };
}

export function readQualifyBundle(dir: string): QualifyBundle {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new SlimExit(EXIT_FAIL, `missing qualification bundle ${dir}`);
  }
  const identityPath = join(dir, "artifact-identity.json");
  if (!existsSync(identityPath)) {
    throw new SlimExit(EXIT_FAIL, `qualification bundle missing artifact-identity.json`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(identityPath, "utf8"));
  } catch (err) {
    throw new SlimExit(
      EXIT_FAIL,
      `qualification bundle identity is not JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  assertDocument("artifactIdentity", raw);
  const identity = raw as ArtifactIdentity;
  const tarballs = readdirSync(dir).filter((n) => n.endsWith(".tgz"));
  if (tarballs.length !== 1) {
    throw new SlimExit(
      EXIT_FAIL,
      `qualification bundle must contain exactly one tarball (found ${tarballs.length})`,
    );
  }
  const receiptsDir = join(dir, "receipts");
  if (!existsSync(receiptsDir) || !statSync(receiptsDir).isDirectory()) {
    throw new SlimExit(EXIT_FAIL, "qualification bundle missing receipts/");
  }
  return { dir, identity, tarball: join(dir, tarballs[0]!), receiptsDir };
}

export function assertQualifyBundle(opts: {
  dir: string;
  commit: string;
  now?: Date;
}): QualifyBundle {
  const bundle = readQualifyBundle(opts.dir);
  if (bundle.identity.commit !== opts.commit) {
    throw new SlimExit(
      EXIT_REFUSED,
      `bundle commit ${bundle.identity.commit} does not match ${opts.commit}`,
    );
  }
  const packedAt = Date.parse(bundle.identity.packedAt);
  const now = (opts.now ?? new Date()).getTime();
  if (!Number.isFinite(packedAt) || now - packedAt > RECEIPT_MAX_AGE_MS) {
    throw new SlimExit(EXIT_FAIL, "qualification bundle is stale");
  }
  const reportPath = join(bundle.dir, QUALIFY_REPORT_NAME);
  if (!existsSync(reportPath)) {
    throw new SlimExit(EXIT_FAIL, "qualification bundle missing qualify-report.json");
  }
  const report = readDocument("qualifyReport", reportPath) as QualifyReport;
  if (report.outcome !== "pass") {
    throw new SlimExit(EXIT_FAIL, `qualification report outcome ${report.outcome} is not pass`);
  }
  if (report.commit !== bundle.identity.commit) {
    throw new SlimExit(EXIT_FAIL, "qualification report commit does not match bundle identity");
  }
  if (report.npmDigest !== bundle.identity.npmDigest) {
    throw new SlimExit(EXIT_FAIL, "qualification report npmDigest does not match bundle identity");
  }
  if (report.actionDigest !== bundle.identity.actionDigest) {
    throw new SlimExit(EXIT_FAIL, "qualification report actionDigest does not match bundle identity");
  }
  if (!report.workflowRun) {
    throw new SlimExit(EXIT_FAIL, "qualification report missing workflowRun");
  }
  return { ...bundle, report };
}

function tarballBase(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || "package.tgz";
}
