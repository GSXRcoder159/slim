import { test } from "node:test";
import assert from "node:assert/strict";
import { nestedRef, pickUser, ping } from "./index.ts";

test("get default only when undefined", () => {
  assert.equal(pickUser({ profile: { name: "Ada" } }), "Ada");
  assert.equal(pickUser({}), "anonymous");
  assert.equal(pickUser({ profile: { name: undefined } }), "anonymous");
});

test("nested get is same reference", () => {
  const inner = { c: 1 };
  const obj = { a: { b: inner } };
  assert.equal(nestedRef(obj), inner);
});

test("debounce is a function with cancel/flush", () => {
  assert.equal(typeof ping, "function");
  assert.equal(typeof ping.cancel, "function");
  assert.equal(typeof ping.flush, "function");
});
