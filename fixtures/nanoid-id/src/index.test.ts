import { test } from "node:test";
import assert from "node:assert/strict";
import { shortId } from "./index.ts";

test("nanoid returns a 10-character id", () => {
  const id = shortId();
  assert.equal(id.length, 10);
  assert.notEqual(shortId(), id);
});
