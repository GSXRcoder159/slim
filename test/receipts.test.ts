import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { InventoryEntry, SupportInventory } from "../src/support/inventory.ts";
import {
  parseReceipt,
  qualifyInventory,
  receiptFileName,
  sourceReceipt,
  githubReceipt,
  actionReceipt,
  releaseReceipt,
  localReceipt,
  writeReceipt,
  providerReceipt,
} from "../src/support/receipts.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIX = join(ROOT, "test/fixtures/receipts");

const COMMIT = "a".repeat(40);
const NPM = "b".repeat(64);
const NOW = new Date("2026-08-27T14:00:30.000Z");

const entry: InventoryEntry = {
  id: "command.scan",
  kind: "command",
  docs: ["docs/help.txt"],
  checkId: "test/cli.test.ts",
  receiptClass: "local",
  command: "scan",
};

const inventory: SupportInventory = { schemaVersion: 1, entries: [entry] };
const candidate = { commit: COMMIT, npmDigest: NPM, actionDigest: null };

function loadFix(name: string): unknown {
  return JSON.parse(readFileSync(join(FIX, name), "utf8"));
}

test("valid receipt parses", () => {
  const rec = parseReceipt(loadFix("command.scan.json"));
  assert.equal(rec.outcome, "pass");
  assert.equal(rec.commit, COMMIT);
});

test("forbidden secret, prompt, traces, and oracle source are rejected", () => {
  for (const [file, field] of [
    ["secret.json", "apiKey"],
    ["prompt.json", "prompt"],
    ["traces.json", "traces"],
    ["oracle.json", "oracleSource"],
  ] as const) {
    assert.throws(
      () => parseReceipt(loadFix(file)),
      (err: unknown) => err instanceof Error && err.message.includes(field),
    );
  }
});

test("qualify missing receipt fails", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-rec-missing-"));
  const failures = qualifyInventory(inventory, dir, candidate, { now: NOW });
  assert.equal(failures[0]?.reason, "missing receipt");
});

test("qualify current receipt passes", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-rec-ok-"));
  writeFileSync(join(dir, receiptFileName(entry.id)), readFileSync(join(FIX, "command.scan.json")));
  assert.deepEqual(qualifyInventory(inventory, dir, candidate, { now: NOW }), []);
});

test("stale commit fails", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-rec-stale-"));
  writeFileSync(join(dir, receiptFileName(entry.id)), readFileSync(join(FIX, "stale-commit.json")));
  const failures = qualifyInventory(inventory, dir, candidate, { now: NOW });
  assert.match(failures[0]?.reason ?? "", /stale commit/);
});

test("digest mismatch fails", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-rec-dig-"));
  writeFileSync(join(dir, receiptFileName(entry.id)), readFileSync(join(FIX, "digest-mismatch.json")));
  const failures = qualifyInventory(inventory, dir, candidate, { now: NOW });
  assert.match(failures[0]?.reason ?? "", /npm digest/);
});

test("outcome not-verified is not pass", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-rec-nv-"));
  writeFileSync(join(dir, receiptFileName(entry.id)), readFileSync(join(FIX, "outcome-not-verified.json")));
  const failures = qualifyInventory(inventory, dir, candidate, { now: NOW });
  assert.match(failures[0]?.reason ?? "", /not-verified/);
});

test("future timestamps fail against injected clock", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-rec-time-"));
  writeFileSync(join(dir, receiptFileName(entry.id)), readFileSync(join(FIX, "command.scan.json")));
  const failures = qualifyInventory(inventory, dir, candidate, {
    now: new Date("2026-08-27T13:00:00.000Z"),
  });
  assert.match(failures[0]?.reason ?? "", /future/);
});

test("qualify against a two-entry inventory fails closed on the missing one", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-rec-two-"));
  mkdirSync(dir, { recursive: true });
  cpSync(join(FIX, "command.scan.json"), join(dir, receiptFileName("command.scan")));
  const inv: SupportInventory = {
    schemaVersion: 1,
    entries: [
      entry,
      { ...entry, id: "provider.anthropic", kind: "provider", name: "anthropic", receiptClass: "live" },
    ],
  };
  const failures = qualifyInventory(inv, dir, candidate, { now: NOW });
  assert.ok(failures.some((f) => f.entryId === "provider.anthropic" && f.reason === "missing receipt"));
  assert.equal(failures.some((f) => f.entryId === "command.scan"), false);
});

test("writeReceipt persists a schema-valid provider receipt without secrets", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-rec-write-"));
  const rec = parseReceipt(loadFix("command.scan.json"));
  const written = writeReceipt(dir, "provider.anthropic", {
    ...rec,
    checkId: "test/llm-live.test.ts",
    command: "replace",
    fixture: "tiny-add",
    environment: "darwin node-v22.18.0 model=claude-sonnet-4-5",
    provider: "anthropic",
  });
  assert.equal(written, join(dir, "provider.anthropic.json"));
  const round = parseReceipt(JSON.parse(readFileSync(written, "utf8")));
  assert.equal(round.provider, "anthropic");
  assert.match(round.environment ?? "", /model=claude-sonnet-4-5/);
  assert.doesNotMatch(readFileSync(written, "utf8"), /apiKey|ANTHROPIC_API_KEY|prompt/);
});

test("writeReceipt rejects forbidden prompt payloads", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-rec-bad-"));
  const rec = parseReceipt(loadFix("command.scan.json"));
  assert.throws(
    () => writeReceipt(dir, "provider.openai", { ...rec, prompt: "secret system" } as never),
    /forbidden field prompt/,
  );
});

test("sourceReceipt is schema-valid with service identity", () => {
  const rec = sourceReceipt({
    service: "osv",
    fixture: "request-watch",
    commit: COMMIT,
    npmDigest: NPM,
    startedAt: new Date("2026-08-27T14:00:00.000Z"),
    endedAt: new Date("2026-08-27T14:00:01.000Z"),
    log: "not-exposed:success:success:0",
  });
  const parsed = parseReceipt(rec);
  assert.equal(parsed.checkId, "test/upstream-live.test.ts");
  assert.equal(parsed.command, "upstream");
  assert.equal(parsed.service, "osv");
  assert.equal(parsed.provider, null);
  assert.equal(parsed.outcome, "pass");
  assert.match(parsed.environment ?? "", /node-/);
});

test("githubReceipt is schema-valid with github service identity", () => {
  const rec = githubReceipt({
    fixture: "ms",
    commit: COMMIT,
    npmDigest: NPM,
    startedAt: new Date("2026-08-27T14:00:00.000Z"),
    endedAt: new Date("2026-08-27T14:00:01.000Z"),
    log: "https://github.com/example/slim-pr/pull/1:closed+deleted",
    prUrl: "https://github.com/example/slim-pr/pull/1",
    cleanup: "closed+deleted",
  });
  const parsed = parseReceipt(rec);
  assert.equal(parsed.checkId, "test/github/pr-live.test.ts");
  assert.equal(parsed.command, "replace");
  assert.equal(parsed.service, "github");
  assert.equal(parsed.provider, null);
  assert.equal(parsed.outcome, "pass");
  assert.match(parsed.environment ?? "", /pr=https:\/\/github.com\/example\/slim-pr\/pull\/1/);
  assert.match(parsed.environment ?? "", /cleanup=closed\+deleted/);
  assert.doesNotMatch(JSON.stringify(parsed), /token|ghp_|github_pat/i);

  const transferred = parseReceipt(
    githubReceipt({
      fixture: "ms",
      commit: COMMIT,
      npmDigest: NPM,
      startedAt: new Date("2026-08-27T14:00:00.000Z"),
      endedAt: new Date("2026-08-27T14:00:01.000Z"),
      log: "https://github.com/example/slim-pr/pull/1:closed+transferred:gsxr-slim-sandbox",
      prUrl: "https://github.com/example/slim-pr/pull/1",
      cleanup: "closed+transferred:gsxr-slim-sandbox",
    }),
  );
  assert.match(transferred.environment ?? "", /cleanup=closed\+transferred:gsxr-slim-sandbox/);
});

test("qualify missing externalService.osv receipt fails closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-rec-osv-"));
  const osv: InventoryEntry = {
    id: "externalService.osv",
    kind: "externalService",
    name: "osv",
    docs: ["docs/dx.md"],
    checkId: "test/upstream-live.test.ts",
    receiptClass: "live",
  };
  const inv: SupportInventory = { schemaVersion: 1, entries: [osv] };
  const failures = qualifyInventory(inv, dir, candidate, { now: NOW });
  assert.deepEqual(failures, [{ entryId: "externalService.osv", reason: "missing receipt" }]);
});

test("qualify stale commit on npm-registry receipt fails closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-rec-npm-stale-"));
  const npmEntry: InventoryEntry = {
    id: "externalService.npm-registry",
    kind: "externalService",
    name: "npm-registry",
    docs: ["docs/dx.md"],
    checkId: "test/upstream-live.test.ts",
    receiptClass: "live",
  };
  writeReceipt(
    dir,
    npmEntry.id,
    sourceReceipt({
      service: "npm-registry",
      fixture: "request-watch",
      commit: "d".repeat(40),
      npmDigest: NPM,
      startedAt: new Date("2026-08-27T14:00:00.000Z"),
      endedAt: new Date("2026-08-27T14:00:01.000Z"),
      log: "ok",
    }),
  );
  const failures = qualifyInventory({ schemaVersion: 1, entries: [npmEntry] }, dir, candidate, { now: NOW });
  assert.match(failures[0]?.reason ?? "", /stale commit/);
});

test("qualify wrong service on OSV receipt fails closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-rec-osv-svc-"));
  const osv: InventoryEntry = {
    id: "externalService.osv",
    kind: "externalService",
    name: "osv",
    docs: ["docs/dx.md"],
    checkId: "test/upstream-live.test.ts",
    receiptClass: "live",
  };
  writeReceipt(
    dir,
    osv.id,
    sourceReceipt({
      service: "npm-registry",
      fixture: "request-watch",
      commit: COMMIT,
      npmDigest: NPM,
      startedAt: new Date("2026-08-27T14:00:00.000Z"),
      endedAt: new Date("2026-08-27T14:00:01.000Z"),
      log: "ok",
    }),
  );
  const failures = qualifyInventory({ schemaVersion: 1, entries: [osv] }, dir, candidate, { now: NOW });
  assert.match(failures[0]?.reason ?? "", /service npm-registry != osv/);
});

const ACTION = "c".repeat(64);

test("releaseReceipt is schema-valid with npm-publish service and both digests", () => {
  const rec = releaseReceipt({
    fixture: "release-rehearse",
    commit: COMMIT,
    npmDigest: NPM,
    actionDigest: ACTION,
    startedAt: new Date("2026-08-27T14:00:00.000Z"),
    endedAt: new Date("2026-08-27T14:00:01.000Z"),
    log: "rehearse:dry-run:ok",
  });
  const parsed = parseReceipt(rec);
  assert.equal(parsed.checkId, "test/release-live.test.ts");
  assert.equal(parsed.command, null);
  assert.equal(parsed.service, "npm-publish");
  assert.equal(parsed.npmDigest, NPM);
  assert.equal(parsed.actionDigest, ACTION);
  assert.equal(parsed.outcome, "pass");
  assert.match(parsed.environment ?? "", /version=0\.1\.0/);
  assert.match(parsed.environment ?? "", /publication=dry-run/);
  assert.match(parsed.environment ?? "", /rollback=restored/);
  assert.match(parsed.environment ?? "", new RegExp(`npmDigest=${NPM}`));
  assert.match(parsed.environment ?? "", new RegExp(`actionDigest=${ACTION}`));
});

const actionEntry: InventoryEntry = {
  id: "action.check",
  kind: "action",
  name: "check",
  docs: ["action/check/action.yml"],
  checkId: "test/github/action-live.test.ts",
  receiptClass: "live",
};

const ACTION_CONSUMER = "GSXRcoder159/slim-action-consumer";
const ACTION_REF = "refs/tags/v1";

function checkActionReceipt(
  extra: Partial<{
    command: "check" | "bloat" | "upstream";
    actionDigest: string;
    workflowRun: string | null;
    log: string;
    repository: string;
    ref: string;
    cells: string;
  }> = {},
) {
  return actionReceipt({
    command: extra.command ?? "check",
    fixture: "packed-action-consumer",
    commit: COMMIT,
    actionDigest: extra.actionDigest ?? ACTION,
    startedAt: new Date("2026-08-27T14:00:00.000Z"),
    endedAt: new Date("2026-08-27T14:00:01.000Z"),
    log: extra.log ?? "ok",
    workflowRun: extra.workflowRun,
    repository: extra.repository ?? ACTION_CONSUMER,
    ref: extra.ref ?? ACTION_REF,
    cells: extra.cells,
  });
}

test("actionReceipt is schema-valid with action digest identity", () => {
  const rec = checkActionReceipt({ log: "ubuntu-latest:22.18:check:0" });
  const parsed = parseReceipt(rec);
  assert.equal(parsed.checkId, "test/github/action-live.test.ts");
  assert.equal(parsed.command, "check");
  assert.equal(parsed.actionDigest, ACTION);
  assert.equal(parsed.npmDigest, null);
  assert.equal(parsed.service, null);
  assert.equal(parsed.outcome, "pass");
  assert.equal(parsed.repository, ACTION_CONSUMER);
  assert.equal(parsed.ref, ACTION_REF);
  assert.match(parsed.environment ?? "", /cells=/);
  assert.doesNotMatch(parsed.environment ?? "", /darwin|linux|win32/);
});

test("qualify missing action.check receipt fails closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-rec-action-missing-"));
  const failures = qualifyInventory({ schemaVersion: 1, entries: [actionEntry] }, dir, {
    ...candidate,
    actionDigest: ACTION,
  }, { now: NOW });
  assert.deepEqual(failures, [{ entryId: "action.check", reason: "missing receipt" }]);
});

test("qualify action digest mismatch fails closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-rec-action-dig-"));
  writeReceipt(
    dir,
    actionEntry.id,
    checkActionReceipt({ actionDigest: "d".repeat(64) }),
  );
  const failures = qualifyInventory({ schemaVersion: 1, entries: [actionEntry] }, dir, {
    ...candidate,
    actionDigest: ACTION,
  }, { now: NOW });
  assert.match(failures[0]?.reason ?? "", /action digest mismatch/);
});

test("localReceipt is schema-valid with command identity", () => {
  const rec = localReceipt({
    entry,
    commit: COMMIT,
    npmDigest: NPM,
    actionDigest: null,
    startedAt: new Date("2026-08-27T14:00:00.000Z"),
    endedAt: new Date("2026-08-27T14:00:01.000Z"),
    log: "ok",
    environment: "darwin node-v22.18.0",
  });
  const parsed = parseReceipt(rec);
  assert.equal(parsed.checkId, "test/cli.test.ts");
  assert.equal(parsed.command, "scan");
  assert.equal(parsed.provider, null);
  assert.equal(parsed.service, null);
  assert.equal(parsed.outcome, "pass");
});

test("qualify command mismatch fails closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-rec-cmd-"));
  writeReceipt(
    dir,
    entry.id,
    localReceipt({
      entry: { ...entry, command: "inspect" },
      commit: COMMIT,
      npmDigest: NPM,
      actionDigest: null,
      startedAt: new Date("2026-08-27T14:00:00.000Z"),
      endedAt: new Date("2026-08-27T14:00:01.000Z"),
      log: "ok",
      environment: "local",
    }),
  );
  const failures = qualifyInventory(inventory, dir, candidate, { now: NOW });
  assert.match(failures[0]?.reason ?? "", /command inspect != scan/);
});

test("qualify osNode environment mismatch fails closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-rec-osn-"));
  const osEntry: InventoryEntry = {
    id: "osNode.ubuntu-latest.22.18",
    kind: "osNode",
    os: "ubuntu-latest",
    node: "22.18",
    docs: [".github/workflows/ci.yml"],
    checkId: "test/docs-contract.test.ts",
    receiptClass: "local",
  };
  writeReceipt(
    dir,
    osEntry.id,
    localReceipt({
      entry: osEntry,
      commit: COMMIT,
      npmDigest: NPM,
      actionDigest: null,
      startedAt: new Date("2026-08-27T14:00:00.000Z"),
      endedAt: new Date("2026-08-27T14:00:01.000Z"),
      log: "ok",
      environment: "macos-latest node-24 darwin node-v24.0.0",
    }),
  );
  const failures = qualifyInventory({ schemaVersion: 1, entries: [osEntry] }, dir, candidate, {
    now: NOW,
  });
  assert.match(failures[0]?.reason ?? "", /osNode environment missing/);
});

test("qualify packageManager environment mismatch fails closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-rec-pm-"));
  const pm: InventoryEntry = {
    id: "packageManager.pnpm",
    kind: "packageManager",
    name: "pnpm",
    docs: ["docs/dx.md"],
    checkId: "test/replace-lockfile-pm.test.ts",
    receiptClass: "local",
  };
  writeReceipt(
    dir,
    pm.id,
    localReceipt({
      entry: pm,
      commit: COMMIT,
      npmDigest: NPM,
      actionDigest: null,
      startedAt: new Date("2026-08-27T14:00:00.000Z"),
      endedAt: new Date("2026-08-27T14:00:01.000Z"),
      log: "ok",
      environment: "darwin node-v22.18.0 npm",
    }),
  );
  const failures = qualifyInventory({ schemaVersion: 1, entries: [pm] }, dir, candidate, {
    now: NOW,
  });
  assert.match(failures[0]?.reason ?? "", /packageManager environment missing pnpm/);
});

test("epoch timestamps fail against the freshness window", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-rec-epoch-"));
  writeFileSync(join(dir, receiptFileName(entry.id)), readFileSync(join(FIX, "epoch.json")));
  const failures = qualifyInventory(inventory, dir, candidate, { now: NOW });
  assert.match(failures[0]?.reason ?? "", /stale|expired|older than/);
});

test("arbitrary fixture names fail closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-rec-arb-"));
  writeFileSync(join(dir, receiptFileName(entry.id)), readFileSync(join(FIX, "arbitrary-fixture.json")));
  const failures = qualifyInventory(inventory, dir, candidate, { now: NOW });
  assert.match(failures[0]?.reason ?? "", /unknown fixture/);
});

test("omitting candidate npm digest cannot disable comparison", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-rec-omit-"));
  writeFileSync(join(dir, receiptFileName(entry.id)), readFileSync(join(FIX, "command.scan.json")));
  const failures = qualifyInventory(
    inventory,
    dir,
    { commit: COMMIT, npmDigest: null, actionDigest: null },
    { now: NOW },
  );
  assert.match(failures[0]?.reason ?? "", /missing npm digest/);
});

test("incompatible receipt schemaVersion is rejected", () => {
  assert.throws(
    () => parseReceipt(loadFix("schema-v2.json")),
    (err: unknown) => err instanceof Error && /schemaVersion|schema/.test(err.message),
  );
});

test("qualify checkId mismatch fails closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-rec-cid-"));
  writeReceipt(
    dir,
    entry.id,
    localReceipt({
      entry: { ...entry, checkId: "test/json-contract.test.ts" },
      commit: COMMIT,
      npmDigest: NPM,
      actionDigest: null,
      startedAt: new Date("2026-08-27T14:00:00.000Z"),
      endedAt: new Date("2026-08-27T14:00:01.000Z"),
      log: "ok",
      environment: "local",
    }),
  );
  const failures = qualifyInventory(inventory, dir, candidate, { now: NOW });
  assert.match(failures[0]?.reason ?? "", /checkId/);
});

test("empty environment fails closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-rec-env-"));
  const rec = localReceipt({
    entry,
    commit: COMMIT,
    npmDigest: NPM,
    actionDigest: null,
    startedAt: new Date("2026-08-27T14:00:00.000Z"),
    endedAt: new Date("2026-08-27T14:00:01.000Z"),
    log: "ok",
    environment: "local",
  });
  writeReceipt(dir, entry.id, { ...rec, environment: "" });
  const failures = qualifyInventory(inventory, dir, candidate, { now: NOW });
  assert.match(failures[0]?.reason ?? "", /environment/);
});

const WORKFLOW = "33135306891";

test("omitting candidate action digest cannot disable comparison", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-rec-omit-act-"));
  writeReceipt(
    dir,
    actionEntry.id,
    checkActionReceipt({ workflowRun: WORKFLOW }),
  );
  const failures = qualifyInventory({ schemaVersion: 1, entries: [actionEntry] }, dir, {
    commit: COMMIT,
    npmDigest: NPM,
    actionDigest: null,
    workflowRun: WORKFLOW,
  }, { now: NOW });
  assert.match(failures[0]?.reason ?? "", /missing action digest/);
});

test("qualify action command mismatch fails closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-rec-act-cmd-"));
  writeReceipt(
    dir,
    actionEntry.id,
    checkActionReceipt({ command: "bloat", workflowRun: WORKFLOW }),
  );
  const failures = qualifyInventory({ schemaVersion: 1, entries: [actionEntry] }, dir, {
    ...candidate,
    actionDigest: ACTION,
    workflowRun: WORKFLOW,
  }, { now: NOW });
  assert.match(failures[0]?.reason ?? "", /command bloat != check/);
});

test("qualify action receipt missing repository fails closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-rec-act-repo-miss-"));
  writeReceipt(dir, actionEntry.id, { ...checkActionReceipt({ workflowRun: WORKFLOW }), repository: null });
  const failures = qualifyInventory({ schemaVersion: 1, entries: [actionEntry] }, dir, {
    ...candidate,
    actionDigest: ACTION,
    workflowRun: WORKFLOW,
  }, { now: NOW });
  assert.match(failures[0]?.reason ?? "", /missing repository/);
});

test("qualify action receipt wrong repository fails closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-rec-act-repo-bad-"));
  writeReceipt(dir, actionEntry.id, checkActionReceipt({ workflowRun: WORKFLOW, repository: "not-a-repo" }));
  const failures = qualifyInventory({ schemaVersion: 1, entries: [actionEntry] }, dir, {
    ...candidate,
    actionDigest: ACTION,
    workflowRun: WORKFLOW,
  }, { now: NOW });
  assert.match(failures[0]?.reason ?? "", /repository mismatch/);
});

test("qualify action receipt wrong ref fails closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-rec-act-ref-"));
  writeReceipt(dir, actionEntry.id, checkActionReceipt({ workflowRun: WORKFLOW, ref: "refs/heads/main" }));
  const failures = qualifyInventory({ schemaVersion: 1, entries: [actionEntry] }, dir, {
    ...candidate,
    actionDigest: ACTION,
    workflowRun: WORKFLOW,
  }, { now: NOW });
  assert.match(failures[0]?.reason ?? "", /ref mismatch/);
});

test("qualify action receipt missing cells in environment fails closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-rec-act-cells-"));
  const rec = checkActionReceipt({ workflowRun: WORKFLOW });
  writeReceipt(dir, actionEntry.id, { ...rec, environment: "repo=owner/name ref=refs/tags/v1" });
  const failures = qualifyInventory({ schemaVersion: 1, entries: [actionEntry] }, dir, {
    ...candidate,
    actionDigest: ACTION,
    workflowRun: WORKFLOW,
  }, { now: NOW });
  assert.match(failures[0]?.reason ?? "", /missing cells/);
});

const osvEntry: InventoryEntry = {
  id: "externalService.osv",
  kind: "externalService",
  name: "osv",
  docs: ["docs/dx.md"],
  checkId: "test/upstream-live.test.ts",
  receiptClass: "live",
};

test("live receipt missing workflow run fails closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-rec-wf-miss-"));
  writeReceipt(
    dir,
    osvEntry.id,
    sourceReceipt({
      service: "osv",
      fixture: "request-watch",
      commit: COMMIT,
      npmDigest: NPM,
      startedAt: new Date("2026-08-27T14:00:00.000Z"),
      endedAt: new Date("2026-08-27T14:00:01.000Z"),
      log: "ok",
    }),
  );
  const failures = qualifyInventory({ schemaVersion: 1, entries: [osvEntry] }, dir, {
    ...candidate,
    workflowRun: WORKFLOW,
  }, { now: NOW });
  assert.match(failures[0]?.reason ?? "", /missing workflow run/);
});

test("live candidate missing workflow run fails closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-rec-wf-cand-"));
  writeReceipt(
    dir,
    osvEntry.id,
    sourceReceipt({
      service: "osv",
      fixture: "request-watch",
      commit: COMMIT,
      npmDigest: NPM,
      startedAt: new Date("2026-08-27T14:00:00.000Z"),
      endedAt: new Date("2026-08-27T14:00:01.000Z"),
      log: "ok",
      workflowRun: WORKFLOW,
    }),
  );
  const failures = qualifyInventory({ schemaVersion: 1, entries: [osvEntry] }, dir, candidate, {
    now: NOW,
  });
  assert.match(failures[0]?.reason ?? "", /missing workflow run/);
});

test("live workflow run mismatch fails closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-rec-wf-mm-"));
  writeReceipt(
    dir,
    osvEntry.id,
    sourceReceipt({
      service: "osv",
      fixture: "request-watch",
      commit: COMMIT,
      npmDigest: NPM,
      startedAt: new Date("2026-08-27T14:00:00.000Z"),
      endedAt: new Date("2026-08-27T14:00:01.000Z"),
      log: "ok",
      workflowRun: WORKFLOW,
    }),
  );
  const failures = qualifyInventory({ schemaVersion: 1, entries: [osvEntry] }, dir, {
    ...candidate,
    workflowRun: "999",
  }, { now: NOW });
  assert.match(failures[0]?.reason ?? "", /workflow run mismatch/);
});

test("npm-publish requires both digests", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-rec-pub-"));
  const pub: InventoryEntry = {
    id: "externalService.npm-publish",
    kind: "externalService",
    name: "npm-publish",
    docs: ["docs/repo.md"],
    checkId: "test/release-live.test.ts",
    receiptClass: "live",
  };
  writeReceipt(
    dir,
    pub.id,
    releaseReceipt({
      fixture: "release-rehearse",
      commit: COMMIT,
      npmDigest: NPM,
      actionDigest: ACTION,
      startedAt: new Date("2026-08-27T14:00:00.000Z"),
      endedAt: new Date("2026-08-27T14:00:01.000Z"),
      log: "ok",
      workflowRun: WORKFLOW,
    }),
  );
  const missingAction = qualifyInventory({ schemaVersion: 1, entries: [pub] }, dir, {
    commit: COMMIT,
    npmDigest: NPM,
    actionDigest: null,
    workflowRun: WORKFLOW,
  }, { now: NOW });
  assert.match(missingAction[0]?.reason ?? "", /missing action digest/);
  const ok = qualifyInventory({ schemaVersion: 1, entries: [pub] }, dir, {
    commit: COMMIT,
    npmDigest: NPM,
    actionDigest: ACTION,
    workflowRun: WORKFLOW,
  }, { now: NOW });
  assert.deepEqual(ok, []);
});

test("providerReceipt qualifies with live fixture and workflow identity", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-rec-prov-"));
  const prov: InventoryEntry = {
    id: "provider.anthropic",
    kind: "provider",
    name: "anthropic",
    docs: ["docs/dx.md"],
    checkId: "test/llm-live.test.ts",
    receiptClass: "live",
  };
  writeReceipt(
    dir,
    prov.id,
    providerReceipt({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      fixture: "tiny-add",
      commit: COMMIT,
      npmDigest: NPM,
      startedAt: new Date("2026-08-27T14:00:00.000Z"),
      endedAt: new Date("2026-08-27T14:00:01.000Z"),
      log: "ok",
      workflowRun: WORKFLOW,
    }),
  );
  assert.deepEqual(
    qualifyInventory({ schemaVersion: 1, entries: [prov] }, dir, {
      ...candidate,
      workflowRun: WORKFLOW,
    }, { now: NOW }),
    [],
  );
});

test("qualify-receipts refuses missing npm digest", () => {
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", join(ROOT, "scripts/qualify-receipts.ts"), "--commit", COMMIT],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, SLIM_NPM_DIGEST: "", SLIM_ACTION_DIGEST: "" },
    },
  );
  assert.equal(r.status, 2);
  assert.match(r.stderr, /npm-digest/);
});

test("qualify-receipts refuses missing action digest", () => {
  const r = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      join(ROOT, "scripts/qualify-receipts.ts"),
      "--commit",
      COMMIT,
      "--npm-digest",
      NPM,
    ],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, SLIM_ACTION_DIGEST: "" },
    },
  );
  assert.equal(r.status, 2);
  assert.match(r.stderr, /action-digest/);
});

test("measurement claims qualify the checked-in file and fail when stale", () => {
  const meas: InventoryEntry = {
    id: "measurement.claims",
    kind: "measurement",
    docs: ["docs/measurements.json"],
    checkId: "test/measurements.test.ts",
    receiptClass: "local",
    name: "claims",
  };
  const inv: SupportInventory = { schemaVersion: 1, entries: [meas] };
  const dir = mkdtempSync(join(tmpdir(), "slim-rec-meas-"));
  assert.deepEqual(qualifyInventory(inv, dir, candidate, { now: new Date(), root: ROOT }), []);

  const staleRoot = mkdtempSync(join(tmpdir(), "slim-meas-stale-"));
  mkdirSync(join(staleRoot, "docs"), { recursive: true });
  const live = JSON.parse(readFileSync(join(ROOT, "docs/measurements.json"), "utf8")) as {
    date: string;
  };
  writeFileSync(
    join(staleRoot, "docs", "measurements.json"),
    JSON.stringify({ ...live, date: "2020-01-01" }) + "\n",
  );
  const failures = qualifyInventory(inv, dir, candidate, {
    now: new Date("2026-08-29T00:00:00.000Z"),
    root: staleRoot,
  });
  assert.equal(failures[0]?.entryId, "measurement.claims");
  assert.match(failures[0]?.reason ?? "", /freshness|older than/i);
});
