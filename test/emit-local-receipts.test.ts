import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InventoryEntry, SupportInventory } from "../src/support/inventory.ts";
import {
  collectOsNodeReceipts,
  currentOsNodeCell,
  emitLocalReceipts,
  runnerNode,
  runnerOs,
} from "../src/support/emit-local.ts";
import { parseReceipt, receiptFileName } from "../src/support/receipts.ts";

const COMMIT = "a".repeat(40);
const NPM = "b".repeat(64);
const NOW = new Date("2026-08-27T14:00:30.000Z");

function scanEntry(command = "scan"): InventoryEntry {
  return {
    id: `command.${command}`,
    kind: "command",
    command,
    docs: ["docs/help.txt"],
    checkId: "test/cli.test.ts",
    receiptClass: "local",
  };
}

function osEntry(os: "ubuntu-latest" | "macos-latest" | "windows-latest", node: "22.18" | "24"): InventoryEntry {
  return {
    id: `osNode.${os}.${node}`,
    kind: "osNode",
    os,
    node,
    docs: [".github/workflows/ci.yml"],
    checkId: "test/docs-contract.test.ts",
    receiptClass: "local",
  };
}

const localInv: SupportInventory = {
  schemaVersion: 1,
  entries: [
    scanEntry("scan"),
    scanEntry("inspect"),
    osEntry("ubuntu-latest", "22.18"),
    osEntry("macos-latest", "22.18"),
    osEntry("windows-latest", "22.18"),
    {
      id: "provider.openai",
      kind: "provider",
      name: "openai",
      docs: ["README.md"],
      checkId: "test/llm-live.test.ts",
      receiptClass: "live",
    },
  ],
};

test("runnerOs maps GitHub and local platforms", () => {
  assert.equal(runnerOs({ GITHUB_ACTIONS: "true", RUNNER_OS: "Linux" }, "darwin"), "ubuntu-latest");
  assert.equal(runnerOs({ GITHUB_ACTIONS: "1", RUNNER_OS: "macOS" }, "linux"), "macos-latest");
  assert.equal(runnerOs({ GITHUB_ACTIONS: "true", RUNNER_OS: "Windows" }, "linux"), "windows-latest");
  assert.equal(runnerOs({}, "darwin"), "macos-latest");
  assert.equal(runnerOs({}, "linux"), "ubuntu-latest");
  assert.equal(runnerOs({}, "win32"), "windows-latest");
});

test("runnerNode maps inventory cells only", () => {
  assert.equal(runnerNode("v22.18.0"), "22.18");
  assert.equal(runnerNode("22.18.3"), "22.18");
  assert.equal(runnerNode("v24.4.1"), "24");
  assert.equal(runnerNode("v22.19.0"), null);
  assert.equal(runnerNode("v23.0.0"), null);
});

test("currentOsNodeCell is null for unknown node", () => {
  assert.equal(currentOsNodeCell({}, "darwin", "v23.0.0"), null);
  assert.deepEqual(currentOsNodeCell({}, "linux", "v22.18.0"), {
    os: "ubuntu-latest",
    node: "22.18",
  });
});

test("emit writes command receipts and skips live plus other osNode cells", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-emit-ok-"));
  let checks = 0;
  const result = emitLocalReceipts({
    inventory: localInv,
    receiptsDir: dir,
    candidate: { commit: COMMIT, npmDigest: NPM, actionDigest: null },
    root: "/unused",
    cell: { os: "macos-latest", node: "22.18" },
    now: NOW,
    platform: "darwin",
    nodeVersion: "v22.18.0",
    runCheck: (checkId) => {
      checks += 1;
      assert.ok(checkId === "test/cli.test.ts" || checkId === "test/docs-contract.test.ts");
      return { ok: true, log: `pass:${checkId}` };
    },
  });
  assert.equal(checks, 2);
  assert.deepEqual(result.written.sort(), [
    "command.inspect",
    "command.scan",
    "osNode.macos-latest.22.18",
  ]);
  assert.ok(result.skipped.includes("osNode.ubuntu-latest.22.18"));
  assert.ok(result.skipped.includes("osNode.windows-latest.22.18"));
  assert.equal(result.failed.length, 0);
  assert.equal(existsSync(join(dir, "provider.openai.json")), false);

  const scan = parseReceipt(JSON.parse(readFileSync(join(dir, "command.scan.json"), "utf8")));
  assert.equal(scan.command, "scan");
  assert.equal(scan.commit, COMMIT);
  assert.equal(scan.npmDigest, NPM);

  const osn = parseReceipt(
    JSON.parse(readFileSync(join(dir, receiptFileName("osNode.macos-latest.22.18")), "utf8")),
  );
  assert.match(osn.environment ?? "", /macos-latest/);
  assert.match(osn.environment ?? "", /22\.18/);
});

test("emit refuses to mint a non-matching osNode cell", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-emit-wrong-"));
  const result = emitLocalReceipts({
    inventory: { schemaVersion: 1, entries: [osEntry("windows-latest", "24")] },
    receiptsDir: dir,
    candidate: { commit: COMMIT, npmDigest: NPM, actionDigest: null },
    root: "/unused",
    only: "osNode",
    cell: { os: "macos-latest", node: "22.18" },
    now: NOW,
    runCheck: () => ({ ok: true, log: "ok" }),
  });
  assert.deepEqual(result.written, []);
  assert.deepEqual(result.skipped, ["osNode.windows-latest.24"]);
  assert.equal(existsSync(join(dir, "osNode.windows-latest.24.json")), false);
});

test("emit does not write when the named check fails", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-emit-fail-"));
  const result = emitLocalReceipts({
    inventory: { schemaVersion: 1, entries: [scanEntry()] },
    receiptsDir: dir,
    candidate: { commit: COMMIT, npmDigest: NPM, actionDigest: null },
    root: "/unused",
    now: NOW,
    runCheck: () => ({ ok: false, log: "not ok" }),
  });
  assert.deepEqual(result.written, []);
  assert.deepEqual(result.failed, ["command.scan"]);
  assert.equal(existsSync(join(dir, "command.scan.json")), false);
});

test("only osNode writes the matching cell after its check passes", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-emit-osn-"));
  const result = emitLocalReceipts({
    inventory: localInv,
    receiptsDir: dir,
    candidate: { commit: COMMIT, npmDigest: NPM, actionDigest: null },
    root: "/unused",
    only: "osNode",
    cell: { os: "ubuntu-latest", node: "22.18" },
    now: NOW,
    platform: "linux",
    nodeVersion: "v22.18.0",
    env: { GITHUB_ACTIONS: "true", RUNNER_OS: "Linux" },
    runCheck: (checkId) => {
      assert.equal(checkId, "test/docs-contract.test.ts");
      return { ok: true, log: "ci" };
    },
  });
  assert.deepEqual(result.written, ["osNode.ubuntu-latest.22.18"]);
  assert.equal(existsSync(join(dir, "command.scan.json")), false);
});

test("collectOsNodeReceipts copies nested artifact files", () => {
  const from = mkdtempSync(join(tmpdir(), "slim-collect-from-"));
  const dest = mkdtempSync(join(tmpdir(), "slim-collect-dest-"));
  mkdirSync(join(from, "receipt-osNode-ubuntu-latest-22.18"), { recursive: true });
  writeFileSync(
    join(from, "receipt-osNode-ubuntu-latest-22.18", "osNode.ubuntu-latest.22.18.json"),
    "{}\n",
  );
  writeFileSync(join(from, "ignore.txt"), "nope\n");
  const copied = collectOsNodeReceipts(from, dest);
  assert.deepEqual(copied, ["osNode.ubuntu-latest.22.18.json"]);
  assert.equal(existsSync(join(dest, "osNode.ubuntu-latest.22.18.json")), true);
});

test("emit-local does not write a gitignored measurement receipt", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-emit-meas-"));
  const meas: InventoryEntry = {
    id: "measurement.claims",
    kind: "measurement",
    name: "claims",
    docs: ["docs/measurements.json"],
    checkId: "test/measurements.test.ts",
    receiptClass: "local",
  };
  const result = emitLocalReceipts({
    inventory: { schemaVersion: 1, entries: [meas, scanEntry()] },
    receiptsDir: dir,
    candidate: { commit: COMMIT, npmDigest: NPM, actionDigest: null },
    root: "/unused",
    now: NOW,
    runCheck: () => ({ ok: true, log: "ok" }),
  });
  assert.equal(result.written.includes("measurement.claims"), false);
  assert.equal(existsSync(join(dir, "measurement.claims.json")), false);
  assert.deepEqual(result.written, ["command.scan"]);
});
