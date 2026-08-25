import { test } from "node:test";
import assert from "node:assert/strict";
import { stamp, ymd, ymdIso } from "./index.ts";

test("formats a date as YYYY-MM-DD", () => {
  assert.equal(ymd(), "2020-01-15");
  assert.equal(ymdIso(), "2020-01-15");
});

test("stamp is epoch milliseconds", () => {
  assert.equal(stamp(), new Date(2020, 0, 15).getTime());
});
