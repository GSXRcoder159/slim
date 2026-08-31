#!/usr/bin/env node
/**
 * Print one schema-valid qualification handoff report on stdout.
 */
import { parseArgs } from "node:util";
import { EXIT_FAIL, EXIT_USAGE, SlimExit } from "../src/exit.ts";
import { loadInventory } from "../src/support/inventory.ts";
import { qualifyInventory } from "../src/support/receipts.ts";
import {
  qualifyReport,
  qualifyReportPath,
  writeQualifyReport,
} from "../src/support/qualify-report.ts";
import { repoRootFromScript } from "./build.mjs";

const SHA256 = /^[0-9a-f]{64}$/;

const { values } = parseArgs({
  options: {
    receipts: { type: "string" },
    commit: { type: "string" },
    "npm-digest": { type: "string" },
    "action-digest": { type: "string" },
    "workflow-run": { type: "string" },
    "qualification-run": { type: "string" },
    root: { type: "string" },
    branch: { type: "string" },
    repository: { type: "string" },
  },
});

const receipts = values.receipts ?? "qualification/receipts";
const commit = values.commit ?? process.env.SLIM_CANDIDATE_COMMIT;
if (!commit || commit.length !== 40) {
  process.stderr.write("qualify-handoff: --commit (40-char sha) is required\n");
  process.exit(EXIT_USAGE);
}
const npmDigest = values["npm-digest"] ?? process.env.SLIM_NPM_DIGEST ?? null;
const actionDigest = values["action-digest"] ?? process.env.SLIM_ACTION_DIGEST ?? null;
const workflowRun =
  values["workflow-run"] ?? process.env.SLIM_WORKFLOW_RUN ?? process.env.GITHUB_RUN_ID ?? null;
const qualificationRun =
  values["qualification-run"] ?? process.env.SLIM_QUALIFICATION_RUN ?? process.env.GITHUB_RUN_ID ?? null;
if (!npmDigest || !SHA256.test(npmDigest)) {
  process.stderr.write("qualify-handoff: --npm-digest (64-char sha256) is required\n");
  process.exit(EXIT_USAGE);
}
if (!actionDigest || !SHA256.test(actionDigest)) {
  process.stderr.write("qualify-handoff: --action-digest (64-char sha256) is required\n");
  process.exit(EXIT_USAGE);
}
if (!workflowRun) {
  process.stderr.write("qualify-handoff: --workflow-run is required\n");
  process.exit(EXIT_USAGE);
}
if (!qualificationRun) {
  process.stderr.write("qualify-handoff: --qualification-run is required\n");
  process.exit(EXIT_USAGE);
}

try {
  const root = values.root ?? repoRootFromScript();
  const inventory = loadInventory();
  const failures = qualifyInventory(inventory, receipts, {
    commit,
    npmDigest,
    actionDigest,
    workflowRun,
  }, { root });
  const report = qualifyReport({
    commit,
    npmDigest,
    actionDigest,
    workflowRun,
    qualificationRun,
    branch: values.branch,
    repository: values.repository,
    entryCount: inventory.entries.length,
    failures,
  });
  writeQualifyReport(qualifyReportPath(receipts), report);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.outcome !== "pass") {
    throw new SlimExit(EXIT_FAIL, report.summary);
  }
} catch (err) {
  const code = err instanceof SlimExit ? err.code : 1;
  const msg = err instanceof Error ? err.message : String(err);
  if (!msg.startsWith("{")) process.stderr.write(`qualify-handoff: ${msg}\n`);
  process.exit(code);
}
