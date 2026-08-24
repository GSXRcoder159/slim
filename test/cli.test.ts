import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCli, helpText } from "../src/cli.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("parseCli help", () => {
  const a = parseCli(["--help"]);
  assert.equal(a.help, true);
});

test("parseCli watch aliases upstream", () => {
  const a = parseCli(["watch"]);
  assert.equal(a.command, "upstream");
});

test("parseCli replace flags", () => {
  const a = parseCli([
    "replace",
    "lodash",
    "--budget-ms",
    "5000",
    "--no-pr",
    "--dry-run",
    "--seed",
    "1",
  ]);
  assert.equal(a.command, "replace");
  assert.equal(a.pkg, "lodash");
  assert.equal(a.budgetMs, 5000);
  assert.equal(a.noPr, true);
  assert.equal(a.dryRun, true);
  assert.equal(a.seed, 1);
  assert.equal(a.allowFlaky, false);
});

test("parseCli --allow-flaky", () => {
  const a = parseCli(["replace", "chance", "--allow-flaky"]);
  assert.equal(a.allowFlaky, true);
});

test("parseCli --no-install", () => {
  const a = parseCli(["replace", "lodash", "--no-install"]);
  assert.equal(a.noInstall, true);
  const b = parseCli(["replace", "lodash"]);
  assert.equal(b.noInstall, false);
});

test("help text names evidence not proof", () => {
  assert.match(helpText(), /Evidence, not proof/i);
  assert.match(helpText(), /slim replace/);
});

test("help text documents --no-install", () => {
  assert.match(helpText(), /--no-install/);
});

test("help text documents exit codes and stdout/stderr streams", () => {
  assert.match(helpText(), /Exit codes: 0 ok/);
  assert.match(helpText(), /Streams: JSON and human reports on stdout/);
});

test("docs/help.txt matches shipped HELP", () => {
  const snap = readFileSync(join(ROOT, "docs/help.txt"), "utf8");
  assert.equal(snap, helpText());
});

test("parseCli doctor --strict", () => {
  const a = parseCli(["doctor", "--strict"]);
  assert.equal(a.command, "doctor");
  assert.equal(a.strict, true);
  const b = parseCli(["doctor"]);
  assert.equal(b.strict, false);
});
