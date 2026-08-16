import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCli, helpText } from "../src/cli.ts";

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

test("help text names evidence not proof", () => {
  assert.match(helpText(), /Evidence, not proof/i);
  assert.match(helpText(), /slim replace/);
});
