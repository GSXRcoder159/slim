import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advertisedActionUses } from "../../src/release/identity.ts";
import { STAMP_NAME } from "../../action/digest.mjs";
import {
  copyPackedActionCheckout,
  isWorkflowMissingError,
  packAndExtractAction,
  publishedQualifyWorkflow,
  runPackedAction,
  runPackedCli,
  workflowRunIdFromList,
  writeAllSuccessConsumer,
  writeBloatFailConsumer,
  writeCheckFailConsumer,
  writeCheckOkConsumer,
  writeUpstreamFailConsumer,
} from "../helpers/action.ts";

let packDir = "";
let extractDest = "";
let actionRoot = "";
let actionDigest = "";

test("workflow run list treats GitHub 404 as missing, not fatal", () => {
  assert.equal(workflowRunIdFromList("[]"), null);
  assert.equal(workflowRunIdFromList('[{"databaseId":33135306891,"status":"queued"}]'), "33135306891");
  assert.equal(
    isWorkflowMissingError(
      new Error(
        "HTTP 404: workflow qualify-actions.yml not found on the default branch",
      ),
    ),
    true,
  );
  assert.equal(isWorkflowMissingError(new Error("HTTP 403: Resource not accessible")), false);
});

test("published Action matrix uses the advertised pin and digest, not a local checkout", () => {
  const yml = publishedQualifyWorkflow({
    actionRepo: "GSXRcoder159/slim",
    actionTag: "v1",
    actionDigest: "a".repeat(64),
  });
  assert.ok(yml.includes(`uses: ${advertisedActionUses("check")}`));
  assert.ok(yml.includes(`uses: ${advertisedActionUses("bloat")}`));
  assert.ok(yml.includes(`uses: ${advertisedActionUses("upstream")}`));
  assert.doesNotMatch(yml, /uses:\s*\.\/action\//);
  assert.match(yml, /SLIM_ACTION_DIGEST: a{64}/);
  assert.match(yml, /bloat-fail:/);
  assert.match(yml, /check-fail:/);
  assert.match(yml, /upstream-fail:/);
  assert.doesNotMatch(yml, /path: \.slim-action/);
});

function ensurePack(): void {
  if (actionRoot) return;
  const packed = packAndExtractAction();
  packDir = packed.packDir;
  extractDest = packed.extractDest;
  actionRoot = packed.actionRoot;
  actionDigest = packed.actionDigest;
}

after(() => {
  if (packDir) rmSync(packDir, { recursive: true, force: true });
  if (extractDest) rmSync(extractDest, { recursive: true, force: true });
});

test("packed Action checkout has compiled dist, digest stamp, and no src", { timeout: 180_000 }, () => {
  ensurePack();
  assert.ok(existsSync(join(actionRoot, "action/run.mjs")));
  assert.ok(existsSync(join(actionRoot, "action/digest.mjs")));
  assert.ok(existsSync(join(actionRoot, "action/check/action.yml")));
  assert.ok(existsSync(join(actionRoot, "action/bloat/action.yml")));
  assert.ok(existsSync(join(actionRoot, "action/upstream/action.yml")));
  assert.ok(existsSync(join(actionRoot, "dist/github/check-action.js")));
  assert.ok(existsSync(join(actionRoot, "dist/github/bloat-action.js")));
  assert.ok(existsSync(join(actionRoot, "dist/github/upstream-action.js")));
  assert.ok(existsSync(join(actionRoot, "docs/slim.schema.json")));
  assert.equal(existsSync(join(actionRoot, "src")), false);
  const stamp = JSON.parse(readFileSync(join(actionRoot, "dist", STAMP_NAME), "utf8")) as {
    actionSha256: string;
  };
  assert.equal(stamp.actionSha256, actionDigest);
  const runner = readFileSync(join(actionRoot, "action/run.mjs"), "utf8");
  const digest = readFileSync(join(actionRoot, "action/digest.mjs"), "utf8");
  assert.doesNotMatch(runner, /experimental-strip-types/);
  assert.doesNotMatch(digest, /experimental-strip-types/);
});

test("packed Action matches packed CLI on success and failure", { timeout: 180_000 }, () => {
  ensurePack();

  const ok = mkdtempSync(join(tmpdir(), "slim-action-ok-"));
  writeAllSuccessConsumer(ok);
  for (const cmd of ["check", "bloat", "upstream"] as const) {
    const cliArgs = cmd === "upstream" ? ["upstream", "--pr"] : [cmd];
    const action = runPackedAction(actionRoot, cmd, ok);
    const cli = runPackedCli(actionRoot, cliArgs, ok);
    assert.equal(action.status, 0, `${cmd} action ${action.stderr}\n${action.stdout}`);
    assert.equal(cli.status, action.status, `${cmd} cli ${cli.stderr}\n${cli.stdout}`);
    if (cmd === "bloat") {
      assert.match(action.stdout, /slim-bloat: ok/);
      assert.equal(action.stdout, cli.stdout);
    }
    if (cmd === "upstream") {
      assert.match(action.stdout, /no replacements/);
      assert.doesNotMatch(action.stdout, /not exposed/);
      assert.match(cli.stdout, /no replacements/);
    }
  }

  const bloatFail = mkdtempSync(join(tmpdir(), "slim-action-bloat-fail-"));
  writeBloatFailConsumer(bloatFail);
  const bloatA = runPackedAction(actionRoot, "bloat", bloatFail);
  const bloatC = runPackedCli(actionRoot, ["bloat"], bloatFail);
  assert.equal(bloatA.status, 1, bloatA.stderr + bloatA.stdout);
  assert.equal(bloatC.status, bloatA.status);
  assert.match(bloatA.stderr, /lodash/);
  assert.match(bloatC.stderr, /lodash/);

  const checkFail = mkdtempSync(join(tmpdir(), "slim-action-check-fail-"));
  writeCheckFailConsumer(checkFail);
  const checkA = runPackedAction(actionRoot, "check", checkFail);
  const checkC = runPackedCli(actionRoot, ["check"], checkFail);
  assert.equal(checkA.status, 1, checkA.stderr + checkA.stdout);
  assert.equal(checkC.status, checkA.status);

  const checkOk = mkdtempSync(join(tmpdir(), "slim-action-check-ok-"));
  writeCheckOkConsumer(checkOk);
  const checkOkA = runPackedAction(actionRoot, "check", checkOk);
  const checkOkC = runPackedCli(actionRoot, ["check"], checkOk);
  assert.equal(checkOkA.status, 0, checkOkA.stderr + checkOkA.stdout);
  assert.equal(checkOkC.status, checkOkA.status);

  const upFail = mkdtempSync(join(tmpdir(), "slim-action-up-fail-"));
  writeUpstreamFailConsumer(upFail);
  const upA = runPackedAction(actionRoot, "upstream", upFail);
  const upC = runPackedCli(actionRoot, ["upstream", "--pr"], upFail);
  assert.equal(upA.status, 1, upA.stderr + upA.stdout);
  assert.equal(upC.status, upA.status);
  assert.match(upA.stderr + upA.stdout, /manifest/);
  assert.doesNotMatch(upA.stdout, /not exposed/);
  assert.doesNotMatch(upA.stderr, /slice not exposed/);
});

test("packed Action missing, stale, or pin-mismatched dist is exit 4 with no source fallback", { timeout: 180_000 }, () => {
  ensurePack();
  const dest = mkdtempSync(join(tmpdir(), "slim-action-unavail-"));
  copyPackedActionCheckout(actionRoot, dest);
  writeAllSuccessConsumer(dest);

  const badCmd = runPackedAction(dest, "not-a-command", dest);
  assert.equal(badCmd.status, 2);
  assert.match(badCmd.stderr, /usage: run\.mjs/);

  const pinBad = runPackedAction(dest, "check", dest, { SLIM_ACTION_DIGEST: "a".repeat(64) });
  assert.equal(pinBad.status, 4, pinBad.stderr);
  assert.match(pinBad.stderr, /action digest mismatch/);
  assert.doesNotMatch(pinBad.stdout, /experimental-strip-types/);

  const stampPath = join(dest, "dist", STAMP_NAME);
  const stamp = readFileSync(stampPath, "utf8");
  writeFileSync(stampPath, `${JSON.stringify({ ok: true, actionSha256: "b".repeat(64) })}\n`);
  const stale = runPackedAction(dest, "check", dest);
  assert.equal(stale.status, 4, stale.stderr);
  assert.match(stale.stderr, /stale action distributable/);
  writeFileSync(stampPath, stamp);

  rmSync(stampPath, { force: true });
  const noStamp = runPackedAction(dest, "check", dest);
  assert.equal(noStamp.status, 4, noStamp.stderr);
  assert.match(noStamp.stderr, /missing dist\/\.slim-build\.json/);
  writeFileSync(stampPath, stamp);

  rmSync(join(dest, "dist", "github", "check-action.js"), { force: true });
  const missing = runPackedAction(dest, "check", dest);
  assert.equal(missing.status, 4, missing.stderr);
  assert.match(missing.stderr, /missing dist\/github\/check-action\.js/);
  assert.doesNotMatch(missing.stdout, /experimental-strip-types/);
  rmSync(dest, { recursive: true, force: true });
});

test("same-tree Action checkout loads packed schemas like uses: ./action", { timeout: 180_000 }, () => {
  ensurePack();
  const dest = mkdtempSync(join(tmpdir(), "slim-action-same-tree-"));
  copyPackedActionCheckout(actionRoot, dest);
  writeAllSuccessConsumer(dest);
  assert.ok(existsSync(join(dest, "docs", "slim.schema.json")));
  for (const cmd of ["check", "bloat", "upstream"] as const) {
    const action = runPackedAction(dest, cmd, dest);
    assert.equal(action.status, 0, `${cmd} ${action.stderr}\n${action.stdout}`);
  }
  rmSync(dest, { recursive: true, force: true });
});
