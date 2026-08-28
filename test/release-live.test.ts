import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalInventory } from "../src/support/inventory.ts";
import { releaseReceipt, writeReceipt } from "../src/support/receipts.ts";
import { npmContentDigest, extractNpmPack, actionDigestFromPack } from "../src/release/digest.ts";
import { attachCompiledTree, rollbackAttach } from "../src/release/attach.ts";
import { npmPublishTarball } from "../src/release/gate.ts";
import { packSlim, ROOT } from "./helpers/llm-replace.ts";
import { hermeticPmEnv } from "../src/rewrite/lockfile.ts";

const LIVE = process.env.SLIM_RELEASE_LIVE === "1";
const FIXTURE = "release-rehearse";

let packDir = "";
let tarball = "";
let npmDigest: string | null = null;
let actionDigest: string | null = null;
let extractDest = "";
let packRoot = "";

before(() => {
  if (!LIVE) return;
  const packed = packSlim();
  packDir = packed.packDir;
  tarball = packed.tarball;
  npmDigest = npmContentDigest(tarball);
  extractDest = mkdtempSync(join(tmpdir(), "slim-rel-live-x-"));
  packRoot = extractNpmPack(tarball, extractDest);
  actionDigest = actionDigestFromPack(packRoot);
});

after(() => {
  if (packDir) rmSync(packDir, { recursive: true, force: true });
  if (extractDest) rmSync(extractDest, { recursive: true, force: true });
});

function hasGh(): boolean {
  try {
    execFileSync("gh", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function gitToken(): string | undefined {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || undefined;
}

function gh(args: string[], cwd?: string): string {
  return execFileSync("gh", args, { cwd, encoding: "utf8" }).trim();
}

function currentGhUser(): string {
  return JSON.parse(gh(["api", "user"])).login as string;
}

function deleteOrTransferRepo(name: string, owner: string): void {
  try {
    gh(["repo", "delete", `${owner}/${name}`, "--yes"]);
    return;
  } catch (err) {
    const dest = process.env.SLIM_PR_TRANSFER_OWNER;
    if (!dest) {
      throw new Error(
        `leftover disposable repository ${owner}/${name} (gh repo delete failed: ${err instanceof Error ? err.message : String(err)}). Set SLIM_PR_TRANSFER_OWNER or grant delete_repo.`,
      );
    }
    const res = execFileSync(
      "gh",
      ["api", "-X", "POST", `repos/${owner}/${name}/transfer`, "-f", `new_owner=${dest}`],
      { encoding: "utf8" },
    );
    if (!res) {
      throw new Error(`leftover disposable repository ${owner}/${name}: transfer to ${dest} failed`);
    }
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

test("support inventory advertises npm-publish as a required live release entry", () => {
  const entry = canonicalInventory().entries.find((e) => e.id === "externalService.npm-publish");
  assert.ok(entry, "missing externalService.npm-publish");
  assert.equal(entry.kind, "externalService");
  assert.equal(entry.name, "npm-publish");
  assert.equal(entry.receiptClass, "live");
  assert.equal(entry.checkId, "test/release-live.test.ts");
});

test("live packed release rehearsal attaches the Action tree and dry-runs the tarball", { timeout: 300_000 }, () => {
  if (!LIVE) {
    assert.equal(
      process.env.SLIM_RELEASE_LIVE ?? "",
      "",
      "live tests stay registered when SLIM_RELEASE_LIVE is unset",
    );
    return;
  }
  assert.ok(hasGh() || gitToken(), "gh or GITHUB_TOKEN is required when SLIM_RELEASE_LIVE=1");
  assert.ok(hasGh(), "gh is required to create and delete the disposable live repository");
  assert.ok(tarball && npmDigest && actionDigest && packRoot, "packed tarball is required when SLIM_RELEASE_LIVE=1");

  const stamp = Date.now().toString(36);
  const name = `slim-release-live-${stamp}`;
  const dest = mkdtempSync(join(tmpdir(), "slim-rel-live-"));
  let owner = "";
  let leftover: string | null = null;
  const startedAt = new Date();
  try {
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "README.md"), "slim release rehearsal\n");
    git(dest, ["init", "--template=", "-b", "main"]);
    git(dest, ["config", "user.email", "slim@test"]);
    git(dest, ["config", "user.name", "slim"]);
    git(dest, ["add", "README.md"]);
    git(dest, ["commit", "-m", "init"]);
    git(dest, ["tag", "v0.1.0"]);
    gh(["repo", "create", name, "--private", "--source", dest, "--remote", "origin", "--push"], dest);
    leftover = name;
    owner = currentGhUser();

    npmPublishTarball(tarball, { dryRun: true, provenance: false, cwd: dest, env: hermeticPmEnv() });

    const parent = git(dest, ["rev-parse", "HEAD"]);
    const attached = attachCompiledTree({
      gitRoot: dest,
      packRoot,
      parentSha: parent,
      versionTag: "v0.1.0",
      floatingTag: "v1",
      push: true,
    });
    const remote = git(dest, ["ls-remote", "--tags", "origin", "refs/tags/v0.1.0"]);
    assert.match(remote, new RegExp(attached.commit));
    const files = git(dest, ["ls-tree", "-r", "--name-only", attached.commit]);
    assert.match(files, /dist\/main\.js/);
    assert.match(files, /action\/run\.mjs/);
    rollbackAttach(attached, dest);
    execFileSync("git", ["push", "origin", ":refs/tags/v0.1.0", ":refs/tags/v1"], {
      cwd: dest,
      encoding: "utf8",
    });

    const receiptsDir = process.env.SLIM_RECEIPTS_DIR;
    if (receiptsDir) {
      const commit =
        process.env.SLIM_CANDIDATE_COMMIT ??
        execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
      writeReceipt(
        receiptsDir,
        "externalService.npm-publish",
        releaseReceipt({
          fixture: FIXTURE,
          commit,
          npmDigest: process.env.SLIM_NPM_DIGEST ?? npmDigest!,
          actionDigest: process.env.SLIM_ACTION_DIGEST ?? actionDigest!,
          startedAt,
          endedAt: new Date(),
          log: `rehearse:${name}:dry-run:${attached.commit}`,
          workflowRun: process.env.SLIM_WORKFLOW_RUN ?? null,
        }),
      );
    }

    deleteOrTransferRepo(name, owner);
    leftover = null;
  } finally {
    if (leftover && owner) {
      try {
        deleteOrTransferRepo(leftover, owner);
        leftover = null;
      } catch (err) {
        process.stderr.write(String(err) + "\n");
      }
    }
    rmSync(dest, { recursive: true, force: true });
  }
  assert.equal(leftover, null, leftover ? `leftover disposable repository ${owner}/${leftover}` : "");
});
