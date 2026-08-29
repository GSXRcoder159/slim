import { test } from "node:test";
import assert from "node:assert/strict";
import { customId, defaultId, shortId } from "./index.ts";

test("nanoid returns a 10-character id", () => {
  const id = shortId();
  assert.equal(id.length, 10);
  assert.notEqual(shortId(), id);
});

test("default export and customAlphabet", () => {
  assert.equal(defaultId().length, 8);
  const id = customId();
  assert.equal(id.length, 6);
  for (const ch of id) assert.ok("abc".includes(ch));
});
