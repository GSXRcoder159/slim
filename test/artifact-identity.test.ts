import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { artifactIdentity, stampActionSha256 } from "../src/release/digest.ts";
import { assertDocument, validateNamed } from "../src/schema/documents.ts";
import { packAndDigest, removePackDir } from "../src/support/emit-local.ts";
import { build } from "../scripts/build.mjs";
import { withRepoDistLock } from "./helpers/llm-replace.ts";
import { EXIT_FAIL, SlimExit } from "../src/exit.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const COMMIT = "a".repeat(40);
const DIGEST = "b".repeat(64);

test("artifact identity schema accepts a complete document and rejects extras", () => {
  const doc = artifactIdentity({
    commit: COMMIT,
    npmDigest: DIGEST,
    actionDigest: "c".repeat(64),
    distSha256: "d".repeat(64),
    packedAt: "2026-08-28T20:00:00.000Z",
  });
  assertDocument("artifactIdentity", doc);
  assert.equal(validateNamed("artifactIdentity", { ...doc, extra: true })?.kind, "malformed");
  assert.equal(validateNamed("artifactIdentity", { ...doc, schemaVersion: 0 })?.kind, "stale-version");
  assert.throws(
    () => assertDocument("artifactIdentity", { schemaVersion: 1 }),
    (err: unknown) => err instanceof SlimExit && err.code === EXIT_FAIL,
  );
});

test("two packs from the same commit produce identical npm and Action digests", { timeout: 180_000 }, () => {
  withRepoDistLock(() => {
    build(ROOT);
    const a = packAndDigest(ROOT);
    const b = packAndDigest(ROOT);
    try {
      assert.match(a.npmDigest, /^[0-9a-f]{64}$/);
      assert.match(a.actionDigest, /^[0-9a-f]{64}$/);
      assert.match(a.distSha256, /^[0-9a-f]{64}$/);
      assert.equal(a.npmDigest, b.npmDigest);
      assert.equal(a.actionDigest, b.actionDigest);
      assert.equal(a.distSha256, b.distSha256);
      assert.equal(stampActionSha256(join(ROOT, ".")), a.actionDigest);
      const stamp = JSON.parse(readFileSync(join(ROOT, "dist", ".slim-build.json"), "utf8")) as {
        sha256: string;
        actionSha256: string;
      };
      assert.equal(stamp.sha256, a.distSha256);
      assert.equal(stamp.actionSha256, a.actionDigest);
      const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
      assertDocument(
        "artifactIdentity",
        artifactIdentity({
          commit,
          npmDigest: a.npmDigest,
          actionDigest: a.actionDigest,
          distSha256: a.distSha256,
          packedAt: "2026-08-28T20:00:00.000Z",
        }),
      );
    } finally {
      removePackDir(a.packDir);
      removePackDir(b.packDir);
    }
  });
});
