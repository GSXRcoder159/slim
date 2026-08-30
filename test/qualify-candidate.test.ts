import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT_REFUSED, EXIT_USAGE, SlimExit } from "../src/exit.ts";
import { assertMigrationGuidance } from "../src/release/identity.ts";
import { liveTestFiles, runQualifyCandidate } from "../src/support/qualify-candidate.ts";
import { INVENTORY_NODES, INVENTORY_OS, loadInventory } from "../src/support/inventory.ts";
import { localReceipt, providerReceipt, writeReceipt } from "../src/support/receipts.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const COMMIT = "a".repeat(40);
const NPM = "b".repeat(64);
const ACTION = "c".repeat(64);
const NOW = new Date("2026-08-27T14:00:30.000Z");

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function isSlimExit(err: unknown, code: number, re: RegExp): boolean {
  return err instanceof SlimExit && err.code === code && re.test(err.message);
}

function writeOsNodeReceipt(
  dir: string,
  os: (typeof INVENTORY_OS)[number],
  node: (typeof INVENTORY_NODES)[number],
): void {
  const entry = loadInventory().entries.find((e) => e.id === `osNode.${os}.${node}`);
  assert.ok(entry);
  writeReceipt(
    dir,
    entry.id,
    localReceipt({
      entry,
      commit: COMMIT,
      npmDigest: NPM,
      actionDigest: null,
      startedAt: NOW,
      endedAt: NOW,
      log: `${os}:${node}`,
      environment: `${os} node-${node} linux node-v${node}.0`,
    }),
  );
}

test("assertMigrationGuidance refuses a changelog without revert instructions", () => {
  const root = mkdtempSync(join(tmpdir(), "slim-mig-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "@gsxrcoder159/slim", version: "0.1.0" }) + "\n",
  );
  writeFileSync(join(root, "CHANGELOG.md"), "# Changelog\n\n## 0.1.0\n\nNotes.\n");
  assert.throws(
    () => assertMigrationGuidance(root),
    (err: unknown) => isSlimExit(err, EXIT_REFUSED, /Revert \/ migration/),
  );
});

test("assertMigrationGuidance accepts the current version section", () => {
  assertMigrationGuidance(ROOT);
});

test("liveTestFiles stays empty unless live flags are set", () => {
  assert.deepEqual(liveTestFiles({}), []);
  assert.deepEqual(liveTestFiles({ SLIM_LLM_LIVE: "1" }), ["test/llm-live.test.ts"]);
  assert.equal(liveTestFiles({ SLIM_PR_LIVE: "1", SLIM_ACTION_LIVE: "1" }).length, 2);
});

test("collect mode fails closed until all six osNode receipts exist", () => {
  const from = mkdtempSync(join(tmpdir(), "slim-qc-from-"));
  const dest = mkdtempSync(join(tmpdir(), "slim-qc-dest-"));
  const cells = INVENTORY_OS.flatMap((os) => INVENTORY_NODES.map((node) => ({ os, node })));
  for (const cell of cells.slice(0, 5)) writeOsNodeReceipt(from, cell.os, cell.node);

  const missing = runQualifyCandidate({
    root: ROOT,
    mode: "collect",
    receiptsDir: dest,
    fromDir: from,
    commit: COMMIT,
    npmDigest: NPM,
    osNodeOnly: true,
    env: {},
  });
  assert.equal(missing.failures.length, 1);
  assert.match(missing.failures[0]?.reason ?? "", /missing receipt/);

  writeOsNodeReceipt(from, cells[5]!.os, cells[5]!.node);
  const ok = runQualifyCandidate({
    root: ROOT,
    mode: "collect",
    receiptsDir: dest,
    fromDir: from,
    commit: COMMIT,
    npmDigest: NPM,
    osNodeOnly: true,
    env: {},
  });
  assert.deepEqual(ok.failures, []);
});

test("collect mode without npm digest fails closed", () => {
  const from = mkdtempSync(join(tmpdir(), "slim-qc-nodig-"));
  const dest = mkdtempSync(join(tmpdir(), "slim-qc-nodig-dest-"));
  for (const os of INVENTORY_OS) {
    for (const node of INVENTORY_NODES) writeOsNodeReceipt(from, os, node);
  }
  const missing = runQualifyCandidate({
    root: ROOT,
    mode: "collect",
    receiptsDir: dest,
    fromDir: from,
    commit: COMMIT,
    osNodeOnly: true,
    env: {},
  });
  assert.ok(missing.failures.some((f) => /missing npm digest/.test(f.reason)));
});

test("emit mode refuses a dirty tree", () => {
  const root = mkdtempSync(join(tmpdir(), "slim-qc-dirty-"));
  git(root, ["init", "--template=", "-b", "main"]);
  git(root, ["config", "user.email", "slim@test"]);
  git(root, ["config", "user.name", "slim"]);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "@gsxrcoder159/slim",
      version: "0.1.0",
      repository: { type: "git", url: "git+https://github.com/GSXRcoder159/slim.git" },
    }) + "\n",
  );
  writeFileSync(
    join(root, "CHANGELOG.md"),
    "# Changelog\n\n## 0.1.0\n\n### Revert / migration\n\nUndo the PR.\n",
  );
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  writeFileSync(
    join(root, ".github", "workflows", "release.yml"),
    "permissions:\n  id-token: write\n  contents: write\n",
  );
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "init"]);
  writeFileSync(join(root, "dirty.txt"), "nope\n");
  const dest = mkdtempSync(join(tmpdir(), "slim-qc-rec-"));
  try {
    assert.throws(
      () =>
        runQualifyCandidate({
          root,
          mode: "emit",
          receiptsDir: dest,
          commit: COMMIT,
          npmDigest: NPM,
          actionDigest: ACTION,
          pack: () => ({ npmDigest: NPM, actionDigest: ACTION }),
          runCheck: () => ({ ok: true, log: "ok" }),
        }),
      (err: unknown) => isSlimExit(err, EXIT_REFUSED, /dirty/),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collect mode receipts are schema-valid osNode documents", () => {
  const from = mkdtempSync(join(tmpdir(), "slim-qc-schema-"));
  writeOsNodeReceipt(from, "ubuntu-latest", "22.18");
  const raw = JSON.parse(
    readFileSync(join(from, "osNode.ubuntu-latest.22.18.json"), "utf8"),
  ) as { schemaVersion: number; outcome: string; environment: string };
  assert.equal(raw.schemaVersion, 1);
  assert.equal(raw.outcome, "pass");
  assert.match(raw.environment, /ubuntu-latest/);
  assert.match(raw.environment, /22\.18/);
});

test("collect mode without os-node-only fails live entries when workflowRun is omitted", () => {
  const from = mkdtempSync(join(tmpdir(), "slim-qc-live-"));
  const dest = mkdtempSync(join(tmpdir(), "slim-qc-live-dest-"));
  for (const os of INVENTORY_OS) {
    for (const node of INVENTORY_NODES) writeOsNodeReceipt(from, os, node);
  }
  writeReceipt(
    dest,
    "provider.openai",
    providerReceipt({
      provider: "openai",
      model: "test",
      fixture: "tiny-add",
      commit: COMMIT,
      npmDigest: NPM,
      startedAt: NOW,
      endedAt: NOW,
      log: "ok",
      workflowRun: "99",
    }),
  );
  const missing = runQualifyCandidate({
    root: ROOT,
    mode: "collect",
    receiptsDir: dest,
    fromDir: from,
    commit: COMMIT,
    npmDigest: NPM,
    actionDigest: ACTION,
    env: {},
  });
  const live = missing.failures.find((f) => f.entryId === "provider.openai");
  assert.ok(live, JSON.stringify(missing.failures.slice(0, 8)));
  assert.match(live.reason, /missing workflow run/);
});

test("collect mode stamps candidate workflowRun from opts", () => {
  const from = mkdtempSync(join(tmpdir(), "slim-qc-wf-"));
  const dest = mkdtempSync(join(tmpdir(), "slim-qc-wf-dest-"));
  for (const os of INVENTORY_OS) {
    for (const node of INVENTORY_NODES) writeOsNodeReceipt(from, os, node);
  }
  const withRun = runQualifyCandidate({
    root: ROOT,
    mode: "collect",
    receiptsDir: dest,
    fromDir: from,
    commit: COMMIT,
    npmDigest: NPM,
    actionDigest: ACTION,
    workflowRun: "33287137687",
    osNodeOnly: true,
    env: {},
  });
  assert.equal(withRun.workflowRun, "33287137687");
  assert.ok(withRun.failures.some((f) => /workflow run mismatch/.test(f.reason)));
});

test("emit mode passes SLIM_WORKFLOW_RUN into live env", () => {
  const root = mkdtempSync(join(tmpdir(), "slim-qc-liveenv-"));
  git(root, ["init", "--template=", "-b", "main"]);
  git(root, ["config", "user.email", "slim@test"]);
  git(root, ["config", "user.name", "slim"]);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "@gsxrcoder159/slim",
      version: "0.1.0",
      repository: { type: "git", url: "git+https://github.com/GSXRcoder159/slim.git" },
      bugs: { url: "https://github.com/GSXRcoder159/slim/issues" },
      homepage: "https://github.com/GSXRcoder159/slim#readme",
      publishConfig: { registry: "https://registry.npmjs.org" },
    }) + "\n",
  );
  writeFileSync(
    join(root, "CHANGELOG.md"),
    "# Changelog\n\n## 0.1.0\n\n### Revert / migration\n\nUndo the PR.\n",
  );
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  writeFileSync(
    join(root, ".github", "workflows", "release.yml"),
    "permissions:\n  id-token: write\n  contents: write\n",
  );
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "init"]);
  const dest = mkdtempSync(join(tmpdir(), "slim-qc-liveenv-rec-"));
  let captured: NodeJS.ProcessEnv | undefined;
  try {
    runQualifyCandidate({
      root,
      mode: "emit",
      receiptsDir: dest,
      commit: COMMIT,
      npmDigest: NPM,
      actionDigest: ACTION,
      workflowRun: "99",
      pack: () => ({ npmDigest: NPM, actionDigest: ACTION }),
      runCheck: () => ({ ok: true, log: "ok" }),
      env: { SLIM_LLM_LIVE: "1" },
      runLiveFiles: (_files, env) => {
        captured = env;
      },
    });
  } catch {
    // live receipts are absent; the live env must still have been stamped
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.equal(captured?.SLIM_WORKFLOW_RUN, "99");
  assert.equal(captured?.SLIM_CANDIDATE_COMMIT, COMMIT);
  assert.equal(captured?.SLIM_NPM_DIGEST, NPM);
});

test("qualify-candidate collect without os-node-only requires --workflow-run", () => {
  const env = { ...process.env };
  delete env.SLIM_WORKFLOW_RUN;
  delete env.GITHUB_RUN_ID;
  const r = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      join(ROOT, "scripts/qualify-candidate.ts"),
      "--mode",
      "collect",
      "--commit",
      COMMIT,
      "--npm-digest",
      NPM,
      "--action-digest",
      ACTION,
      "--receipts",
      mkdtempSync(join(tmpdir(), "slim-qc-cli-")),
    ],
    { cwd: ROOT, encoding: "utf8", env },
  );
  assert.equal(r.status, EXIT_USAGE);
  assert.match(r.stderr, /workflow-run/);
});
