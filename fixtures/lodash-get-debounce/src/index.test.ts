import { test } from "node:test";
import assert from "node:assert/strict";
import { badDebounce, nestedRef, nestedRefPath, pickUser, ping } from "./index.ts";

test("get default only when undefined", () => {
  assert.equal(pickUser({ profile: { name: "Ada" } }), "Ada");
  assert.equal(pickUser({}), "anonymous");
  assert.equal(pickUser({ profile: { name: undefined } }), "anonymous");
  assert.equal(pickUser({ profile: { name: null } }), null as unknown as string);
  assert.equal(pickUser({ profile: { name: "" } }), "");
});

test("nested get is same reference", () => {
  const inner = { c: 1 };
  const obj = { a: { b: inner } };
  assert.equal(nestedRef(obj), inner);
  assert.equal(nestedRefPath(obj), inner);
  assert.equal(nestedRef(obj), nestedRefPath(obj));
});

test("debounce is a function with cancel/flush, no pending, argc 2", () => {
  assert.equal(typeof ping, "function");
  assert.equal(typeof ping.cancel, "function");
  assert.equal(typeof ping.flush, "function");
  assert.equal("pending" in ping, false);
  assert.equal(typeof (ping as { pending?: unknown }).pending, "undefined");
});

test("debounce TypeError Expected a function", () => {
  assert.throws(() => badDebounce(), { name: "TypeError", message: "Expected a function" });
});
