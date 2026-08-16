import assert from "node:assert/strict";
import { describe, it } from "node:test";
import lodash from "lodash";
import { map } from "../../src/generate/catalog/lodash.map.ts";
import { filter } from "../../src/generate/catalog/lodash.filter.ts";
import { uniq } from "../../src/generate/catalog/lodash.uniq.ts";
import { compact } from "../../src/generate/catalog/lodash.compact.ts";
import { flatten } from "../../src/generate/catalog/lodash.flatten.ts";
import { chunk } from "../../src/generate/catalog/lodash.chunk.ts";
import { take } from "../../src/generate/catalog/lodash.take.ts";
import { head } from "../../src/generate/catalog/lodash.head.ts";
import { last } from "../../src/generate/catalog/lodash.last.ts";

describe("lodash.map", () => {
  it("maps arrays and objects; iteratee may be a function or property path", () => {
    assert.deepEqual(map([4, 8], (n: number) => n * n), [16, 64]);
    assert.deepEqual(map({ a: 1, b: 2 }), lodash.map({ a: 1, b: 2 }));
    assert.deepEqual(map([{ n: 1 }, { n: 2 }], "n"), lodash.map([{ n: 1 }, { n: 2 }], "n"));
    assert.deepEqual(map([{ a: { b: 1 } }], "a.b"), lodash.map([{ a: { b: 1 } }], "a.b"));
    assert.deepEqual(map("ab"), lodash.map("ab"));
    assert.deepEqual(map(null), lodash.map(null));
    assert.deepEqual(map([["a", "b"], ["c"]], 0), lodash.map([["a", "b"], ["c"]], 0));
  });

  it("passes value, key, collection", () => {
    const keys: unknown[] = [];
    map({ z: 1, a: 2 }, (_v, k) => keys.push(k));
    assert.deepEqual(keys, ["z", "a"]);
  });
});

describe("lodash.filter", () => {
  it("filters arrays and objects with function or shorthand", () => {
    const users = [
      { user: "barney", age: 36, active: true },
      { user: "fred", age: 40, active: false },
    ];
    assert.deepEqual(
      filter(users, (o: (typeof users)[0]) => !o.active),
      lodash.filter(users, (o) => !o.active),
    );
    assert.deepEqual(filter(users, { age: 36, active: true }), lodash.filter(users, { age: 36, active: true }));
    assert.deepEqual(filter([{ x: 1, y: 0 }, { x: 0, y: 1 }], "x"), lodash.filter([{ x: 1, y: 0 }, { x: 0, y: 1 }], "x"));
    assert.deepEqual(filter({ a: 0, b: 1, c: false, d: 2 }), lodash.filter({ a: 0, b: 1, c: false, d: 2 }));
    assert.deepEqual(filter(null), lodash.filter(null));
    assert.deepEqual(filter([{ a: 1, b: 2 }, { a: 1, b: 3 }], ["b", 2]), lodash.filter([{ a: 1, b: 2 }, { a: 1, b: 3 }], ["b", 2]));
  });
});

describe("lodash.uniq / compact / flatten", () => {
  it("uniq uses SameValueZero and keeps first occurrence", () => {
    assert.deepEqual(uniq([2, 1, 2]), lodash.uniq([2, 1, 2]));
    assert.deepEqual(uniq([NaN, NaN]), lodash.uniq([NaN, NaN]));
    assert.deepEqual(uniq([0, -0]), lodash.uniq([0, -0]));
    assert.deepEqual(uniq(null), lodash.uniq(null));
    assert.deepEqual(uniq("aab"), lodash.uniq("aab"));
  });

  it("compact drops falsey values", () => {
    assert.deepEqual(compact([0, 1, false, 2, "", 3]), lodash.compact([0, 1, false, 2, "", 3]));
    assert.deepEqual(compact(null), lodash.compact(null));
  });

  it("flatten is one level; nested arrays remain nested", () => {
    assert.deepEqual(flatten([1, [2, [3, [4]], 5]]), lodash.flatten([1, [2, [3, [4]], 5]]));
    assert.deepEqual(flatten(null), lodash.flatten(null));
    assert.deepEqual(flatten("ab"), lodash.flatten("ab"));
    const args = function nestedArgs() { return arguments; }(2, 3);
    assert.deepEqual(flatten([1, args]), lodash.flatten([1, args]));
  });
});

describe("lodash.chunk / take / head / last", () => {
  it("chunk splits, treating non-positive size as empty", () => {
    assert.deepEqual(chunk(["a", "b", "c", "d"], 2), lodash.chunk(["a", "b", "c", "d"], 2));
    assert.deepEqual(chunk(["a", "b", "c", "d"], 3), lodash.chunk(["a", "b", "c", "d"], 3));
    assert.deepEqual(chunk([1, 2, 3], 0), lodash.chunk([1, 2, 3], 0));
    assert.deepEqual(chunk([1, 2, 3, 4, 5], 2.7), lodash.chunk([1, 2, 3, 4, 5], 2.7));
    assert.deepEqual(chunk([1, 2, 3, 4], "2"), lodash.chunk([1, 2, 3, 4], "2"));
    assert.deepEqual(chunk("abcd", 2), lodash.chunk("abcd", 2));
  });

  it("take / head / last match lodash including empty and null", () => {
    assert.deepEqual(take([1, 2, 3]), lodash.take([1, 2, 3]));
    assert.deepEqual(take([1, 2, 3], 2), lodash.take([1, 2, 3], 2));
    assert.deepEqual(take([1, 2, 3], 5), lodash.take([1, 2, 3], 5));
    assert.deepEqual(take([1, 2, 3], 0), lodash.take([1, 2, 3], 0));
    assert.deepEqual(take([1, 2, 3], -1), lodash.take([1, 2, 3], -1));
    assert.deepEqual(take("abcd", 2), lodash.take("abcd", 2));
    assert.equal(head([1, 2, 3]), lodash.head([1, 2, 3]));
    assert.equal(head([]), lodash.head([]));
    assert.equal(head(null), lodash.head(null));
    assert.equal(head("ab"), lodash.head("ab"));
    assert.equal(last([1, 2, 3]), lodash.last([1, 2, 3]));
    assert.equal(last([]), lodash.last([]));
    assert.equal(last(null), lodash.last(null));
  });
});
