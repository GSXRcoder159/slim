#!/usr/bin/env node
/**
 * GitHub composite-action entry. Runs only the compiled Action distributable.
 * Missing or stale dist is exit 4. Never falls back to repository source.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyActionDistributable } from "./digest.mjs";

const cmd = process.argv[2];
const extra = process.argv.slice(3);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const verified = verifyActionDistributable(root, cmd, process.env.SLIM_ACTION_DIGEST);
if (!verified.ok) {
  process.stderr.write(verified.message + "\n");
  process.exit(verified.exit);
}

const r = spawnSync(process.execPath, [verified.dist, ...extra], {
  stdio: "inherit",
  env: process.env,
});
if (r.error) {
  process.stderr.write(String(r.error) + "\n");
  process.exit(1);
}
process.exit(r.status ?? 1);
