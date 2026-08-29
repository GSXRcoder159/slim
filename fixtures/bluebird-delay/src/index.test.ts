import { test } from "node:test";
import assert from "node:assert/strict";
import { both, first, later, nope, ok, readCb, viaCtor } from "./index.ts";

test("resolve yields the value", async () => {
  assert.equal(await ok("ok"), "ok");
});

test("reject, all, race, delay, promisify, Promise, default", async () => {
  await assert.rejects(async () => {
    await nope("nope");
  }, /nope/);
  assert.deepEqual(await both("a", "b"), ["a", "b"]);
  assert.equal(await first("a", "b"), "a");
  assert.equal(await later("later"), "later");
  assert.equal(await readCb(), 7);
  assert.equal(await viaCtor(3), 3);
});
