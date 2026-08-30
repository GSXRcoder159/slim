#!/usr/bin/env node
/**
 * Pack the qualification bundle: artifact-identity.json, one tarball, receipts/.
 */
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { EXIT_USAGE, SlimExit } from "../src/exit.ts";
import { writeQualifyBundle } from "../src/release/bundle.ts";
import { packAndDigest, removePackDir } from "../src/support/emit-local.ts";
import { repoRootFromScript } from "./build.mjs";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    out: { type: "string" },
    receipts: { type: "string" },
    commit: { type: "string" },
  },
});

const root = values.root ?? repoRootFromScript();
const out = values.out;
if (!out) {
  process.stderr.write("pack-qualify-bundle: --out is required\n");
  process.exit(EXIT_USAGE);
}
const receipts = values.receipts ?? "qualification/receipts";
let packDir: string | undefined;
try {
  const commit =
    values.commit ??
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new SlimExit(EXIT_USAGE, "pack-qualify-bundle: --commit (40-char sha) is required");
  }
  const packed = packAndDigest(root);
  packDir = packed.packDir;
  const bundle = writeQualifyBundle({
    dir: out,
    tarball: packed.tarball,
    receiptsDir: receipts,
    commit,
    npmDigest: packed.npmDigest,
    actionDigest: packed.actionDigest,
    distSha256: packed.distSha256,
  });
  process.stdout.write(
    `pack-qualify-bundle: ${bundle.tarball} npm=${bundle.identity.npmDigest} action=${bundle.identity.actionDigest}\n`,
  );
} catch (err) {
  const code = err instanceof SlimExit ? err.code : 1;
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`pack-qualify-bundle: ${msg}\n`);
  process.exit(code);
} finally {
  if (packDir) removePackDir(packDir);
}
