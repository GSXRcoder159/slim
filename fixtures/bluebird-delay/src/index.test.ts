import { test } from "node:test";
import assert from "node:assert/strict";
import { ok } from "./index.ts";

test("resolve yields the value", async () => {
  assert.equal(await ok("ok"), "ok");
});
