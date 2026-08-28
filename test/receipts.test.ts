import { test } from "node:test";
import assert from "node:assert/strict";
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
  writeReceipt,
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
    fixture: "ms-watch",
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
    log: "https://github.com/example/slim-pr/pull/1",
  });
  const parsed = parseReceipt(rec);
  assert.equal(parsed.checkId, "test/github/pr-live.test.ts");
  assert.equal(parsed.command, "replace");
  assert.equal(parsed.service, "github");
  assert.equal(parsed.provider, null);
  assert.equal(parsed.outcome, "pass");
  assert.doesNotMatch(JSON.stringify(parsed), /token|ghp_|github_pat/i);
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
      fixture: "ms-watch",
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
      fixture: "ms-watch",
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
const actionEntry: InventoryEntry = {
  id: "action.check",
  kind: "action",
  name: "check",
  docs: ["action/check/action.yml"],
  checkId: "test/github/action-live.test.ts",
  receiptClass: "live",
};

test("actionReceipt is schema-valid with action digest identity", () => {
  const rec = actionReceipt({
    command: "check",
    fixture: "packed-action-consumer",
    commit: COMMIT,
    actionDigest: ACTION,
    startedAt: new Date("2026-08-27T14:00:00.000Z"),
    endedAt: new Date("2026-08-27T14:00:01.000Z"),
    log: "ubuntu-latest:22.18:check:0",
  });
  const parsed = parseReceipt(rec);
  assert.equal(parsed.checkId, "test/github/action-live.test.ts");
  assert.equal(parsed.command, "check");
  assert.equal(parsed.actionDigest, ACTION);
  assert.equal(parsed.npmDigest, null);
  assert.equal(parsed.service, null);
  assert.equal(parsed.outcome, "pass");
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
    actionReceipt({
      command: "check",
      fixture: "packed-action-consumer",
      commit: COMMIT,
      actionDigest: "d".repeat(64),
      startedAt: new Date("2026-08-27T14:00:00.000Z"),
      endedAt: new Date("2026-08-27T14:00:01.000Z"),
      log: "ok",
    }),
  );
  const failures = qualifyInventory({ schemaVersion: 1, entries: [actionEntry] }, dir, {
    ...candidate,
    actionDigest: ACTION,
  }, { now: NOW });
  assert.match(failures[0]?.reason ?? "", /action digest mismatch/);
});
