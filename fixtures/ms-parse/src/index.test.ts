import { test } from "node:test";
import assert from "node:assert/strict";
import { formatMs, hourMs } from "./index.ts";

test("parses a single duration token", () => {
  assert.equal(hourMs(), 3_600_000);
  assert.equal(formatMs(3_600_000), "1h");
});
