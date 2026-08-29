#!/usr/bin/env node
/**
 * Release gate: every support-inventory entry must have a current passing receipt.
 */
import { parseArgs } from "node:util";
import { loadInventory } from "../src/support/inventory.ts";
import { qualifyInventory } from "../src/support/receipts.ts";

const { values } = parseArgs({
  options: {
    receipts: { type: "string" },
    commit: { type: "string" },
    "npm-digest": { type: "string" },
    "action-digest": { type: "string" },
    "workflow-run": { type: "string" },
  },
});

const SHA256 = /^[0-9a-f]{64}$/;
const receipts = values.receipts ?? "qualification/receipts";
const commit = values.commit ?? process.env.SLIM_CANDIDATE_COMMIT;
if (!commit || commit.length !== 40) {
  process.stderr.write("qualify-receipts: --commit (40-char sha) is required\n");
  process.exit(2);
}
const npmDigest = values["npm-digest"] ?? process.env.SLIM_NPM_DIGEST ?? null;
const actionDigest = values["action-digest"] ?? process.env.SLIM_ACTION_DIGEST ?? null;
if (!npmDigest || !SHA256.test(npmDigest)) {
  process.stderr.write("qualify-receipts: --npm-digest (64-char sha256) is required\n");
  process.exit(2);
}
if (!actionDigest || !SHA256.test(actionDigest)) {
  process.stderr.write("qualify-receipts: --action-digest (64-char sha256) is required\n");
  process.exit(2);
}

const inventory = loadInventory();
const failures = qualifyInventory(inventory, receipts, {
  commit,
  npmDigest,
  actionDigest,
  workflowRun: values["workflow-run"] ?? process.env.SLIM_WORKFLOW_RUN ?? null,
});

if (!failures.length) {
  process.stdout.write(`qualify-receipts: ${inventory.entries.length} receipts current\n`);
  process.exit(0);
}

process.stderr.write(`qualify-receipts: ${failures.length} failure(s)\n`);
for (const f of failures) {
  process.stderr.write(`  ${f.entryId}: ${f.reason}\n`);
}
process.exit(1);
