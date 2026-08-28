#!/usr/bin/env node
/**
 * Emit local support-inventory receipts after named checkIds pass.
 */
import { parseArgs } from "node:util";
import { repoRootFromScript } from "./build.mjs";
import { emitLocalReceipts, packAndDigest, removePackDir } from "../src/support/emit-local.ts";
import { loadInventory } from "../src/support/inventory.ts";

const { values } = parseArgs({
  options: {
    receipts: { type: "string" },
    commit: { type: "string" },
    "npm-digest": { type: "string" },
    "action-digest": { type: "string" },
    only: { type: "string" },
    pack: { type: "boolean", default: false },
    root: { type: "string" },
  },
});

const commit = values.commit ?? process.env.SLIM_CANDIDATE_COMMIT;
if (!commit || commit.length !== 40) {
  process.stderr.write("emit-local-receipts: --commit (40-char sha) is required\n");
  process.exit(2);
}

const only = values.only;
if (only !== undefined && only !== "osNode") {
  process.stderr.write("emit-local-receipts: --only must be osNode\n");
  process.exit(2);
}

const root = values.root ?? repoRootFromScript();
const receipts = values.receipts ?? "qualification/receipts";
let npmDigest = values["npm-digest"] ?? process.env.SLIM_NPM_DIGEST ?? null;
let actionDigest = values["action-digest"] ?? process.env.SLIM_ACTION_DIGEST ?? null;
let packDir: string | undefined;

try {
  if (values.pack || !npmDigest || !actionDigest) {
    const packed = packAndDigest(root);
    npmDigest = packed.npmDigest;
    actionDigest = packed.actionDigest;
    packDir = packed.packDir;
    process.stdout.write(`emit-local-receipts: npm=${npmDigest} action=${actionDigest}\n`);
  }

  const result = emitLocalReceipts({
    inventory: loadInventory(),
    receiptsDir: receipts,
    candidate: { commit, npmDigest, actionDigest },
    root,
    only: only === "osNode" ? "osNode" : undefined,
  });

  process.stdout.write(
    `emit-local-receipts: wrote ${result.written.length} skipped ${result.skipped.length} failed ${result.failed.length}\n`,
  );
  if (result.failed.length) {
    process.stderr.write(`emit-local-receipts: failed ${result.failed.join(", ")}\n`);
    process.exit(1);
  }
  if (only === "osNode" && result.written.length !== 1) {
    process.stderr.write(
      `emit-local-receipts: expected one osNode receipt for this runner, wrote ${result.written.length}\n`,
    );
    process.exit(1);
  }
} finally {
  if (packDir) removePackDir(packDir);
}
