import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actionManifest } from "../../action/digest.mjs";
import {
  ADVERTISED_ACTION_TAG,
  EXPECTED_GITHUB_REPO,
  advertisedActionUses,
  packageVersion,
  versionTag,
} from "../../src/release/identity.ts";
import { attachCompiledTree } from "../../src/release/attach.ts";
import { canonicalInventory } from "../../src/support/inventory.ts";
import { actionReceipt, writeReceipt } from "../../src/support/receipts.ts";
import { hermeticPmEnv, execPm } from "../../src/rewrite/lockfile.ts";
import {
  copyExampleWorkflows,
  isWorkflowMissingError,
  packAndExtractAction,
  publishedQualifyWorkflow,
  workflowRunIdFromList,
  writeAllSuccessConsumer,
  writeBloatFailConsumer,
  writeCheckFailConsumer,
  writeUpstreamFailConsumer,
} from "../helpers/action.ts";
import { ROOT } from "../helpers/llm-replace.ts";

const LIVE = process.env.SLIM_ACTION_LIVE === "1";
const FIXTURE = "packed-action-consumer";
const CELLS =
  "ubuntu-latest/22.18,ubuntu-latest/24,macos-latest/22.18,macos-latest/24,windows-latest/22.18,windows-latest/24";

let packDir = "";
let extractDest = "";
let actionRoot = "";
let actionDigest: string | null = null;

before(() => {
  if (!LIVE) return;
  const packed = packAndExtractAction();
  packDir = packed.packDir;
  extractDest = packed.extractDest;
  actionRoot = packed.actionRoot;
  actionDigest = packed.actionDigest;
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

function billingBlockMessage(text: string): string | null {
  const m = text.match(
    /The job was not started because recent account payments have failed or your spending limit needs to be increased[^\n]*/i,
  );
  if (m) return m[0];
  if (/spending limit|payments have failed/i.test(text)) return text.slice(0, 500);
  return null;
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

function ensureCanonicalPublic(): void {
  const view = JSON.parse(
    gh(["repo", "view", EXPECTED_GITHUB_REPO, "--json", "isPrivate,url"]),
  ) as { isPrivate: boolean; url: string };
  if (!view.isPrivate) return;
  gh([
    "repo",
    "edit",
    EXPECTED_GITHUB_REPO,
    "--visibility",
    "public",
    "--accept-visibility-change-consequences",
  ]);
  const again = JSON.parse(gh(["repo", "view", EXPECTED_GITHUB_REPO, "--json", "isPrivate"])) as {
    isPrivate: boolean;
  };
  assert.equal(again.isPrivate, false, `${EXPECTED_GITHUB_REPO} must be public for published Actions`);
}

function publishCompiledActionTags(packRoot: string, digest: string): void {
  const clone = mkdtempSync(join(tmpdir(), "slim-action-attach-"));
  const verify = mkdtempSync(join(tmpdir(), "slim-action-verify-"));
  try {
    execFileSync("gh", ["repo", "clone", EXPECTED_GITHUB_REPO, clone, "--", "--depth", "1"], {
      encoding: "utf8",
      timeout: 120_000,
    });
    const parentSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: clone,
      encoding: "utf8",
    }).trim();
    attachCompiledTree({
      gitRoot: clone,
      packRoot,
      parentSha,
      versionTag: versionTag(packageVersion(ROOT)),
      floatingTag: ADVERTISED_ACTION_TAG,
      push: true,
    });
    execFileSync(
      "git",
      ["clone", "--depth", "1", "--branch", ADVERTISED_ACTION_TAG, `https://github.com/${EXPECTED_GITHUB_REPO}.git`, verify],
      { encoding: "utf8", timeout: 120_000 },
    );
    const { sha256 } = actionManifest(verify);
    assert.equal(sha256, digest, "published v1 Action tree digest must match packed actionDigest");
  } finally {
    rmSync(clone, { recursive: true, force: true });
    rmSync(verify, { recursive: true, force: true });
  }
}

function writeLiveConsumer(dest: string, digest: string): void {
  writeAllSuccessConsumer(dest);
  copyExampleWorkflows(dest);
  assert.ok(
    existsSync(join(dest, ".github", "workflows", "slim-check.yml")),
    "consumer must include the documented check example unchanged",
  );
  mkdirSync(join(dest, "consumers", "bloat-fail"), { recursive: true });
  mkdirSync(join(dest, "consumers", "check-fail"), { recursive: true });
  mkdirSync(join(dest, "consumers", "upstream-fail"), { recursive: true });
  writeBloatFailConsumer(join(dest, "consumers", "bloat-fail"));
  writeCheckFailConsumer(join(dest, "consumers", "check-fail"));
  writeUpstreamFailConsumer(join(dest, "consumers", "upstream-fail"));
  writeFileSync(
    join(dest, ".github", "workflows", "qualify-actions.yml"),
    publishedQualifyWorkflow({
      actionRepo: EXPECTED_GITHUB_REPO,
      actionTag: ADVERTISED_ACTION_TAG,
      actionDigest: digest,
    }),
  );
  writeFileSync(join(dest, ".gitignore"), "node_modules\n");
  writeFileSync(join(dest, ".gitattributes"), "* text=auto eol=lf\n");
  execPm("npm", ["install"], {
    cwd: dest,
    encoding: "utf8",
    timeout: 120_000,
    env: hermeticPmEnv({ CI: "1" }),
  });
}

function waitForWorkflowRun(dest: string, workflow: string): string {
  let last = "";
  for (let i = 0; i < 36; i++) {
    try {
      const listed = gh(
        ["run", "list", "--workflow", workflow, "--json", "databaseId,status,conclusion,displayTitle", "--limit", "3"],
        dest,
      );
      last = listed;
      const id = workflowRunIdFromList(listed);
      if (id) return id;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
      const billed = billingBlockMessage(last);
      if (billed) {
        throw new Error(`GitHub Actions billing blocked ${workflow}: ${billed}`);
      }
      if (!isWorkflowMissingError(err)) throw err;
    }
    execFileSync("sleep", ["5"]);
  }
  const billed = billingBlockMessage(last);
  throw new Error(
    billed
      ? `GitHub Actions billing blocked ${workflow}: ${billed}`
      : `GitHub Actions run did not appear for ${workflow}: ${last}`,
  );
}

function watchRun(dest: string, runId: string, workflow: string): {
  conclusion: string;
  url: string;
  jobs: Array<{ name: string; conclusion: string }>;
  log: string;
} {
  try {
    gh(["run", "watch", runId, "--exit-status"], dest);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const billed = billingBlockMessage(msg);
    throw new Error(
      billed
        ? `GitHub Actions billing blocked ${workflow}: ${billed}`
        : `${workflow} run ${runId} failed: ${msg}`,
    );
  }
  const view = JSON.parse(
    gh(["run", "view", runId, "--json", "conclusion,status,url,jobs"], dest),
  ) as {
    conclusion: string;
    url: string;
    jobs: Array<{ name: string; conclusion: string }>;
  };
  const log = gh(["run", "view", runId, "--log"], dest);
  const billed = billingBlockMessage(log) ?? billingBlockMessage(JSON.stringify(view));
  if (billed) {
    throw new Error(`GitHub Actions billing blocked ${workflow}: ${billed}`);
  }
  return { ...view, log };
}

test("support inventory advertises compiled Actions as required live entries", () => {
  for (const name of ["check", "bloat", "upstream"] as const) {
    const entry = canonicalInventory().entries.find((e) => e.id === `action.${name}`);
    assert.ok(entry, `missing action.${name}`);
    assert.equal(entry.kind, "action");
    assert.equal(entry.name, name);
    assert.equal(entry.receiptClass, "live");
    assert.equal(entry.checkId, "test/github/action-live.test.ts");
    assert.ok(entry.docs.includes("docs/release-identity.md"));
  }
});

test("live packed Actions pass on every advertised runner/Node cell", { timeout: 900_000 }, () => {
  if (!LIVE) {
    assert.equal(
      process.env.SLIM_ACTION_LIVE ?? "",
      "",
      "live tests stay registered when SLIM_ACTION_LIVE is unset",
    );
    return;
  }
  assert.ok(hasGh() || gitToken(), "gh or GITHUB_TOKEN is required when SLIM_ACTION_LIVE=1");
  assert.ok(hasGh(), "gh is required to create and delete the disposable live repository");
  assert.ok(actionRoot && actionDigest, "packed Action extract is required when SLIM_ACTION_LIVE=1");

  ensureCanonicalPublic();
  publishCompiledActionTags(actionRoot, actionDigest);

  const stamp = Date.now().toString(36);
  const name = `slim-action-live-${stamp}`;
  const dest = mkdtempSync(join(tmpdir(), "slim-action-live-"));
  let owner = "";
  let leftover: string | null = null;
  const startedAt = new Date();
  try {
    writeLiveConsumer(dest, actionDigest);
    execFileSync("git", ["init", "--template=", "-b", "main"], { cwd: dest, encoding: "utf8" });
    execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: dest });
    execFileSync("git", ["config", "user.email", "slim@test"], { cwd: dest });
    execFileSync("git", ["config", "user.name", "slim"], { cwd: dest });
    execFileSync("git", ["add", "-A"], { cwd: dest });
    execFileSync("git", ["commit", "-m", "init packed action consumer"], { cwd: dest });
    gh(["repo", "create", name, "--public", "--source", dest, "--remote", "origin", "--push"], dest);
    leftover = name;
    owner = currentGhUser();

    const matrixId = waitForWorkflowRun(dest, "qualify-actions.yml");
    const matrix = watchRun(dest, matrixId, "qualify-actions.yml");
    assert.equal(matrix.conclusion, "success", JSON.stringify(matrix.jobs));
    const cells = matrix.jobs.filter(
      (j) => /cell/i.test(j.name) || j.name.includes("22.18") || j.name.includes("24"),
    );
    assert.ok(cells.length >= 6, `expected 6 matrix jobs, got ${JSON.stringify(matrix.jobs)}`);
    for (const job of matrix.jobs) {
      assert.equal(job.conclusion, "success", job.name);
    }
    assert.doesNotMatch(matrix.log, /experimental-strip-types/);
    assert.doesNotMatch(matrix.log, /stale action distributable/);
    assert.doesNotMatch(matrix.log, /slice not exposed/);
    assert.match(matrix.log, /lodash/);

    const checkId = waitForWorkflowRun(dest, "slim-check.yml");
    const checkRun = watchRun(dest, checkId, "slim-check.yml");
    assert.equal(checkRun.conclusion, "success", JSON.stringify(checkRun.jobs));
    assert.doesNotMatch(checkRun.log, /experimental-strip-types/);

    execFileSync("git", ["checkout", "-b", "slim-bloat-pr"], { cwd: dest });
    writeFileSync(join(dest, "pr-trigger.txt"), "open documented bloat example\n");
    execFileSync("git", ["add", "pr-trigger.txt"], { cwd: dest });
    execFileSync("git", ["commit", "-m", "trigger documented examples"], { cwd: dest });
    execFileSync("git", ["push", "-u", "origin", "HEAD"], { cwd: dest });
    gh(["pr", "create", "--fill", "--head", "slim-bloat-pr", "--base", "main"], dest);
    const bloatId = waitForWorkflowRun(dest, "slim-bloat.yml");
    const bloatRun = watchRun(dest, bloatId, "slim-bloat.yml");
    assert.equal(bloatRun.conclusion, "success", JSON.stringify(bloatRun.jobs));

    gh(["workflow", "run", "slim-watch.yml"], dest);
    const watchId = waitForWorkflowRun(dest, "slim-watch.yml");
    const watch = watchRun(dest, watchId, "slim-watch.yml");
    assert.equal(watch.conclusion, "success", JSON.stringify(watch.jobs));
    assert.doesNotMatch(watch.log, /slice not exposed/);

    const receiptsDir = process.env.SLIM_RECEIPTS_DIR;
    if (receiptsDir) {
      const commit =
        process.env.SLIM_CANDIDATE_COMMIT ??
        execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
      const endedAt = new Date();
      const repository = `${owner}/${name}`;
      const ref = `refs/tags/${ADVERTISED_ACTION_TAG}`;
      for (const command of ["check", "bloat", "upstream"] as const) {
        writeReceipt(
          receiptsDir,
          `action.${command}`,
          actionReceipt({
            command,
            fixture: FIXTURE,
            commit,
            actionDigest: process.env.SLIM_ACTION_DIGEST ?? actionDigest,
            startedAt,
            endedAt,
            log: `${matrix.url}:${command}:${matrix.conclusion}:uses=${advertisedActionUses(command)}`,
            workflowRun: process.env.SLIM_WORKFLOW_RUN ?? matrixId,
            repository,
            ref,
            cells: CELLS,
          }),
        );
      }
    }

    const prs = JSON.parse(gh(["pr", "list", "--json", "number", "--state", "open"], dest)) as Array<{
      number: number;
    }>;
    for (const pr of prs) {
      gh(["pr", "close", String(pr.number), "--delete-branch"], dest);
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
