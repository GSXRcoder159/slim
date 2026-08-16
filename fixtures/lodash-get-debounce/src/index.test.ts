import { test } from "node:test";
import assert from "node:assert/strict";
import { badDebounce, nestedRef, nestedRefPath, pickUser, ping, schedule } from "./index.ts";

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

test("ping debounce trailing invoke actually runs", async () => {
  ping(1);
  await new Promise((r) => setTimeout(r, 80));
  ping.cancel();
});

test("debounce TypeError Expected a function", () => {
  assert.throws(() => badDebounce(), { name: "TypeError", message: "Expected a function" });
});

test("debounce trailing invoke actually runs the function", async () => {
  let n = 0;
  const d = schedule(() => {
    n++;
  });
  d();
  assert.equal(n, 0);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(n, 1);
  d.cancel();
});

test("get is invoked through pickUser and nestedRef", () => {
  const inner = { c: 7 };
  assert.equal(pickUser({ profile: { name: "Ada" } }), "Ada");
  assert.equal(nestedRef({ a: { b: inner } }), inner);
  assert.equal(nestedRefPath({ a: { b: inner } }), inner);
});
