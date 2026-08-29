import { test } from "node:test";
import assert from "node:assert/strict";
import { asDate, shifted, stamp, unix, validIso, ymd, ymdIso } from "./index.ts";

test("formats a date as YYYY-MM-DD", () => {
  assert.equal(ymd(), "2020-01-15");
  assert.equal(ymdIso(), "2020-01-15");
});

test("stamp is epoch milliseconds", () => {
  assert.equal(stamp(), new Date(2020, 0, 15).getTime());
});

test("unix, toDate, add/subtract, and isValid", () => {
  assert.equal(unix(), Math.floor(new Date(2020, 0, 15).getTime() / 1000));
  assert.equal(asDate().getTime(), new Date(2020, 0, 15).getTime());
  assert.equal(validIso(), true);
  assert.match(shifted(), /^2020-01-1[45] /);
});
