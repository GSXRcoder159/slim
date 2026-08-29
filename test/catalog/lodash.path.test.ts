import assert from "node:assert/strict";
import { describe, it } from "node:test";
import lodash from "lodash";
import { get } from "../../src/generate/catalog/lodash.get.ts";
import { set } from "../../src/generate/catalog/lodash.set.ts";
import { has } from "../../src/generate/catalog/lodash.has.ts";

const obj = { a: [{ b: { c: 3 } }] };

describe("lodash.get", () => {
  it("matches documented dotted and bracket paths", () => {
    assert.equal(get(obj, "a[0].b.c"), lodash.get(obj, "a[0].b.c"));
    assert.equal(get(obj, ["a", "0", "b", "c"]), lodash.get(obj, ["a", "0", "b", "c"]));
    assert.equal(get(obj, "a.b.c", "default"), lodash.get(obj, "a.b.c", "default"));
  });

  it("returns default only when the resolved value is === undefined", () => {
    assert.equal(get({ a: null }, "a", "d"), null);
    assert.equal(get({ a: null }, "a", "d"), lodash.get({ a: null }, "a", "d"));
    assert.equal(get({ a: undefined }, "a", "d"), "d");
    assert.equal(get({ a: 0 }, "a", "d"), 0);
    assert.equal(get({ a: false }, "a", "d"), false);
    assert.equal(get({ a: "" }, "a", "d"), "");
    assert.equal(get({ a: null }, "a.b", "d"), lodash.get({ a: null }, "a.b", "d"));
  });

  it("returns the same nested reference as the input subtree", () => {
    const inner = { x: 1 };
    const root = { a: inner };
    assert.equal(get(root, "a"), inner);
    assert.equal(lodash.get(root, "a"), inner);
  });

  it("treats a dotted string as a single key when that key exists", () => {
    const mixed = { "a.b": 1, a: { b: 2 } };
    assert.equal(get(mixed, "a.b"), lodash.get(mixed, "a.b"));
    assert.equal(get({ a: { b: 2 } }, "a.b"), lodash.get({ a: { b: 2 } }, "a.b"));
  });

  it("parses quotes, leading dots, and empty segments like lodash", () => {
    assert.equal(get({ a: { "b.c": 1 } }, 'a["b.c"]'), 1);
    assert.equal(get({ a: { "b.c": 1 } }, "a['b.c']"), 1);
    assert.equal(get({ "": { a: 1 } }, ".a"), lodash.get({ "": { a: 1 } }, ".a"));
    assert.equal(get({ a: { "": { b: 2 } } }, "a..b"), lodash.get({ a: { "": { b: 2 } } }, "a..b"));
    assert.equal(get({ "": 1 }, ""), lodash.get({ "": 1 }, ""));
  });

  it("returns undefined (or default) for an empty array path", () => {
    assert.equal(get({ a: 1 }, []), lodash.get({ a: 1 }, []));
    assert.equal(get({ a: 1 }, [], "DEF"), lodash.get({ a: 1 }, [], "DEF"));
  });

  it("handles nullish objects and primitive indexing", () => {
    assert.equal(get(null, "a", 5), lodash.get(null, "a", 5));
    assert.equal(get(undefined, "a", 5), lodash.get(undefined, "a", 5));
    assert.equal(get("hi", 0), lodash.get("hi", 0));
    assert.equal(get({ 0: "z" }, 0), lodash.get({ 0: "z" }, 0));
    assert.equal(get({ true: 1 }, true), lodash.get({ true: 1 }, true));
  });
});

describe("lodash.set", () => {
  it("creates arrays for index segments and objects otherwise", () => {
    assert.deepEqual(set({}, "a[0].b", 1), lodash.set({}, "a[0].b", 1));
    assert.deepEqual(set({}, ["x", "0", "y", "z"], 5), lodash.set({}, ["x", "0", "y", "z"], 5));
  });

  it("mutates and returns the same object", () => {
    const target = { a: [{ b: { c: 3 } }] };
    const returned = set(target, "a[0].b.c", 4);
    assert.equal(returned, target);
    assert.equal(target.a[0].b.c, 4);
  });

  it("overwrites primitives on the path and ignores null destinations", () => {
    assert.deepEqual(set({ a: 1 }, "a.b", 2), lodash.set({ a: 1 }, "a.b", 2));
    assert.equal(set(null, "a", 1), lodash.set(null, "a", 1));
    assert.equal(set(undefined, "a", 1), lodash.set(undefined, "a", 1));
    assert.deepEqual(set({ a: 1 }, [], 9), lodash.set({ a: 1 }, [], 9));
    assert.deepEqual(set({}, {}, 1), lodash.set({}, {}, 1));
  });

  it("does not pollute Object.prototype via __proto__ / constructor / prototype", () => {
    const before = Object.prototype.hasOwnProperty("polluted");
    set({}, "__proto__.polluted", true);
    set({}, "constructor.prototype.polluted", true);
    set({}, "prototype.polluted", true);
    assert.equal(Object.prototype.hasOwnProperty("polluted"), before);
    assert.equal(({ } as { polluted?: boolean }).polluted, undefined);
    assert.deepEqual(set({}, "__proto__", { x: 1 }), {});
    assert.deepEqual(set({}, "constructor", 1), {});
  });

  it("sets a leading-dot path onto the empty-string key", () => {
    assert.deepEqual(set({}, ".a", 1), lodash.set({}, ".a", 1));
  });
});

describe("lodash.has", () => {
  it("checks own nested paths, not inherited ones", () => {
    const object = { a: { b: 2 } };
    const other = Object.create({ a: Object.create({ b: 2 }) });
    assert.equal(has(object, "a"), lodash.has(object, "a"));
    assert.equal(has(object, "a.b"), lodash.has(object, "a.b"));
    assert.equal(has(object, ["a", "b"]), lodash.has(object, ["a", "b"]));
    assert.equal(has(other, "a"), lodash.has(other, "a"));
    assert.equal(has(Object.create({ a: 1 }), "a"), false);
    assert.equal(has(Object.create({ a: { b: 1 } }), "a.b"), false);
  });

  it("is true for own undefined and false for missing nested keys", () => {
    assert.equal(has({ a: undefined }, "a"), true);
    assert.equal(has({ a: {} }, "a.b"), false);
    assert.equal(has({ a: 1 }, []), lodash.has({ a: 1 }, []));
  });

  it("handles arrays and empty-string keys", () => {
    assert.equal(has([1, 2, 3], 2), lodash.has([1, 2, 3], 2));
    assert.equal(has([1], "length"), lodash.has([1], "length"));
    assert.equal(has({ "": 1 }, ""), lodash.has({ "": 1 }, ""));
    assert.equal(has({ "a.b": 1 }, "a.b"), lodash.has({ "a.b": 1 }, "a.b"));
  });
});
