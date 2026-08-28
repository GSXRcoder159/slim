import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalInventory } from "../../src/support/inventory.ts";
import { actionReceipt, writeReceipt } from "../../src/support/receipts.ts";
import { hermeticPmEnv } from "../../src/rewrite/lockfile.ts";
import {
  copyPackedActionCheckout,
  packAndExtractAction,
  writeAllSuccessConsumer,
  writeBloatFailConsumer,
  writeCheckFailConsumer,
  writeUpstreamFailConsumer,
} from "../helpers/action.ts";
import { ROOT } from "../helpers/llm-replace.ts";

const LIVE = process.env.SLIM_ACTION_LIVE === "1";
const FIXTURE = "packed-action-consumer";

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

const QUALIFY_WORKFLOW = `name: qualify-actions
on:
  push:
jobs:
  cell:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
        node: ["22.18", "24"]
    runs-on: \${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: \${{ matrix.node }}
      - run: npm ci
      - name: check success
        uses: ./action/check
      - name: bloat success
        uses: ./action/bloat
      - name: upstream success
        uses: ./action/upstream
      - name: bloat fail expected
        id: bloat_fail
        continue-on-error: true
        working-directory: consumers/bloat-fail
        shell: bash
        run: node "\${{ github.workspace }}/action/run.mjs" bloat
      - name: assert bloat failed
        if: steps.bloat_fail.outcome != 'failure'
        shell: bash
        run: echo "bloat fail path did not fail" >&2; exit 1
      - name: check fail expected
        id: check_fail
        continue-on-error: true
        working-directory: consumers/check-fail
        shell: bash
        run: node "\${{ github.workspace }}/action/run.mjs" check
      - name: assert check failed
        if: steps.check_fail.outcome != 'failure'
        shell: bash
        run: echo "check fail path did not fail" >&2; exit 1
      - name: upstream fail expected
        id: up_fail
        continue-on-error: true
        working-directory: consumers/upstream-fail
        shell: bash
        run: node "\${{ github.workspace }}/action/run.mjs" upstream
      - name: assert upstream failed
        if: steps.up_fail.outcome != 'failure'
        shell: bash
        run: echo "upstream fail path did not fail" >&2; exit 1
`;

function writeLiveRepo(dest: string): void {
  copyPackedActionCheckout(actionRoot, dest);
  writeAllSuccessConsumer(dest);
  assert.ok(
    existsSync(join(dest, "docs", "slim.schema.json")),
    "packed Action checkout needs docs schemas next to dist",
  );
  mkdirSync(join(dest, "consumers", "bloat-fail"), { recursive: true });
  mkdirSync(join(dest, "consumers", "check-fail"), { recursive: true });
  mkdirSync(join(dest, "consumers", "upstream-fail"), { recursive: true });
  writeBloatFailConsumer(join(dest, "consumers", "bloat-fail"));
  writeCheckFailConsumer(join(dest, "consumers", "check-fail"));
  writeUpstreamFailConsumer(join(dest, "consumers", "upstream-fail"));
  mkdirSync(join(dest, ".github", "workflows"), { recursive: true });
  writeFileSync(join(dest, ".github", "workflows", "qualify-actions.yml"), QUALIFY_WORKFLOW);
  writeFileSync(join(dest, ".gitignore"), "node_modules\n");
  writeFileSync(join(dest, ".gitattributes"), "* text=auto eol=lf\n");
  execFileSync("npm", ["install"], {
    cwd: dest,
    encoding: "utf8",
    timeout: 120_000,
    env: hermeticPmEnv({ CI: "1" }),
  });
}

test("support inventory advertises compiled Actions as required live entries", () => {
  for (const name of ["check", "bloat", "upstream"] as const) {
    const entry = canonicalInventory().entries.find((e) => e.id === `action.${name}`);
    assert.ok(entry, `missing action.${name}`);
    assert.equal(entry.kind, "action");
    assert.equal(entry.name, name);
    assert.equal(entry.receiptClass, "live");
    assert.equal(entry.checkId, "test/github/action-live.test.ts");
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

  const stamp = Date.now().toString(36);
  const name = `slim-action-live-${stamp}`;
  const dest = mkdtempSync(join(tmpdir(), "slim-action-live-"));
  let owner = "";
  let leftover: string | null = null;
  const startedAt = new Date();
  try {
    writeLiveRepo(dest);
    execFileSync("git", ["init", "--template=", "-b", "main"], { cwd: dest, encoding: "utf8" });
    execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: dest });
    execFileSync("git", ["config", "user.email", "slim@test"], { cwd: dest });
    execFileSync("git", ["config", "user.name", "slim"], { cwd: dest });
    execFileSync("git", ["add", "-A"], { cwd: dest });
    execFileSync("git", ["commit", "-m", "init packed action consumer"], { cwd: dest });
    gh(["repo", "create", name, "--private", "--source", dest, "--remote", "origin", "--push"], dest);
    leftover = name;
    owner = currentGhUser();

    let runId = "";
    for (let i = 0; i < 30; i++) {
      const listed = gh(
        ["run", "list", "--workflow", "qualify-actions.yml", "--json", "databaseId,status,conclusion", "--limit", "1"],
        dest,
      );
      const rows = JSON.parse(listed) as Array<{ databaseId: number; status: string }>;
      if (rows[0]?.databaseId) {
        runId = String(rows[0].databaseId);
        break;
      }
      execFileSync("sleep", ["5"]);
    }
    assert.ok(runId, "GitHub Actions run did not appear");
    gh(["run", "watch", runId, "--exit-status"], dest);
    const view = JSON.parse(
      gh(["run", "view", runId, "--json", "conclusion,status,url,jobs"], dest),
    ) as {
      conclusion: string;
      url: string;
      jobs: Array<{ name: string; conclusion: string }>;
    };
    assert.equal(view.conclusion, "success", JSON.stringify(view.jobs));
    const cells = view.jobs.filter((j) => /cell/i.test(j.name) || j.name.includes("22.18") || j.name.includes("24"));
    assert.ok(cells.length >= 6, `expected 6 matrix jobs, got ${JSON.stringify(view.jobs)}`);
    for (const job of view.jobs) {
      assert.equal(job.conclusion, "success", job.name);
    }
    const log = gh(["run", "view", runId, "--log"], dest);
    assert.doesNotMatch(log, /experimental-strip-types/);
    assert.doesNotMatch(log, /stale action distributable/);
    assert.doesNotMatch(log, /slice not exposed/);

    const receiptsDir = process.env.SLIM_RECEIPTS_DIR;
    if (receiptsDir) {
      const commit =
        process.env.SLIM_CANDIDATE_COMMIT ??
        execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
      const endedAt = new Date();
      for (const command of ["check", "bloat", "upstream"] as const) {
        writeReceipt(
          receiptsDir,
          `action.${command}`,
          actionReceipt({
            command,
            fixture: FIXTURE,
            commit,
            actionDigest: process.env.SLIM_ACTION_DIGEST ?? actionDigest!,
            startedAt,
            endedAt,
            log: `${view.url}:${command}:${view.conclusion}`,
            workflowRun: process.env.SLIM_WORKFLOW_RUN ?? runId,
          }),
        );
      }
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
