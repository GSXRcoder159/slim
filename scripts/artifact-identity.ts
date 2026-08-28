#!/usr/bin/env node
/**
 * Print one schema-valid packed artifact identity document on stdout.
 */
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { EXIT_USAGE, SlimExit } from "../src/exit.ts";
import { artifactIdentity } from "../src/release/digest.ts";
import { assertDocument } from "../src/schema/documents.ts";
import { packAndDigest, removePackDir } from "../src/support/emit-local.ts";
import { build, repoRootFromScript, withDistLock } from "./build.mjs";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    commit: { type: "string" },
  },
});

const root = values.root ?? repoRootFromScript();
let packDir: string | undefined;
try {
  const commit =
    values.commit ??
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new SlimExit(EXIT_USAGE, "artifact-identity: --commit (40-char sha) is required");
  }
  const packed = withDistLock(root, () => {
    build(root);
    return packAndDigest(root);
  });
  packDir = packed.packDir;
  const doc = artifactIdentity({
    commit,
    npmDigest: packed.npmDigest,
    actionDigest: packed.actionDigest,
    distSha256: packed.distSha256,
  });
  assertDocument("artifactIdentity", doc);
  process.stdout.write(`${JSON.stringify(doc)}\n`);
} catch (err) {
  const code = err instanceof SlimExit ? err.code : 1;
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`artifact-identity: ${msg}\n`);
  process.exit(code);
} finally {
  if (packDir) removePackDir(packDir);
}
