#!/usr/bin/env node
/**
 * Pack the qualification bundle: artifact-identity.json, one tarball, receipts/, qualify-report.json.
 * --from-bundle reuses a CI tarball. --verify packs once and refuses digest drift.
 */
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { EXIT_FAIL, EXIT_USAGE, SlimExit } from "../src/exit.ts";
import { readQualifyBundle, writeQualifyBundle } from "../src/release/bundle.ts";
import { packAndDigest, removePackDir } from "../src/support/emit-local.ts";
import { repoRootFromScript } from "./build.mjs";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    out: { type: "string" },
    receipts: { type: "string" },
    commit: { type: "string" },
    "from-bundle": { type: "string" },
    verify: { type: "boolean", default: false },
  },
});

const root = values.root ?? repoRootFromScript();
const receipts = values.receipts ?? "qualification/receipts";
const out = values.out;
let packDir: string | undefined;
try {
  const commit =
    values.commit ??
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new SlimExit(EXIT_USAGE, "pack-qualify-bundle: --commit (40-char sha) is required");
  }

  const seed = values["from-bundle"] ? readQualifyBundle(values["from-bundle"]) : null;
  if (seed && seed.identity.commit !== commit) {
    throw new SlimExit(
      EXIT_FAIL,
      `pack-qualify-bundle: seed commit ${seed.identity.commit} does not match ${commit}`,
    );
  }

  if (!seed) {
    if (!out) throw new SlimExit(EXIT_USAGE, "pack-qualify-bundle: --out is required");
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
  } else {
    if (values.verify) {
      const packed = packAndDigest(root);
      packDir = packed.packDir;
      if (packed.npmDigest !== seed.identity.npmDigest) {
        throw new SlimExit(EXIT_FAIL, "pack-qualify-bundle: npmDigest does not match seed bundle");
      }
      if (packed.actionDigest !== seed.identity.actionDigest) {
        throw new SlimExit(EXIT_FAIL, "pack-qualify-bundle: actionDigest does not match seed bundle");
      }
    }
    if (!out) {
      if (!values.verify) {
        throw new SlimExit(EXIT_USAGE, "pack-qualify-bundle: --out is required");
      }
      process.stdout.write(
        `pack-qualify-bundle: verified npm=${seed.identity.npmDigest} action=${seed.identity.actionDigest}\n`,
      );
    } else {
      const bundle = writeQualifyBundle({
        dir: out,
        tarball: seed.tarball,
        receiptsDir: receipts,
        commit: seed.identity.commit,
        npmDigest: seed.identity.npmDigest,
        actionDigest: seed.identity.actionDigest,
        distSha256: seed.identity.distSha256,
        packedAt: seed.identity.packedAt,
      });
      process.stdout.write(
        `pack-qualify-bundle: ${bundle.tarball} npm=${bundle.identity.npmDigest} action=${bundle.identity.actionDigest} from-bundle\n`,
      );
    }
  }
} catch (err) {
  const code = err instanceof SlimExit ? err.code : 1;
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`pack-qualify-bundle: ${msg}\n`);
  process.exit(code);
} finally {
  if (packDir) removePackDir(packDir);
}
