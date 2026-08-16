import assert from "node:assert/strict";
import { describe, it } from "node:test";
import lodash from "lodash";
import { pick } from "../../src/generate/catalog/lodash.pick.ts";
import { omit } from "../../src/generate/catalog/lodash.omit.ts";
import { keys } from "../../src/generate/catalog/lodash.keys.ts";
import { values } from "../../src/generate/catalog/lodash.values.ts";
import { assign } from "../../src/generate/catalog/lodash.assign.ts";

describe("lodash.pick / omit", () => {
  it("picks listed own and nested paths", () => {
    const object = { a: 1, b: "2", c: 3 };
    assert.deepEqual(pick(object, ["a", "c"]), lodash.pick(object, ["a", "c"]));
    assert.deepEqual(pick(object, "a", "c"), lodash.pick(object, "a", "c"));
    assert.deepEqual(pick({ a: { b: 1, c: 2 } }, "a.b"), lodash.pick({ a: { b: 1, c: 2 } }, "a.b"));
    assert.deepEqual(pick(null, "a"), lodash.pick(null, "a"));
    const inner = { b: 1 };
    const root = { a: inner };
    assert.equal(pick(root, "a").a, inner);
  });

  it("picks inherited properties (lodash pick walks the prototype)", () => {
    assert.deepEqual(pick(Object.create({ a: 1 }), "a"), lodash.pick(Object.create({ a: 1 }), "a"));
  });

  it("omits paths without mutating nested originals", () => {
    const object = { a: 1, b: "2", c: 3 };
    assert.deepEqual(omit(object, ["a", "c"]), lodash.omit(object, ["a", "c"]));
    const nested = { a: { b: 1, c: 2 }, d: 3 };
    assert.deepEqual(omit(nested, "a.b"), lodash.omit(nested, "a.b"));
    assert.equal(nested.a.b, 1);
    const inner = { b: 1, c: 2 };
    const o = { inner, d: 3 };
    const omitted = omit(o, "d");
    assert.equal(omitted.inner, inner);
    assert.deepEqual(omit(Object.create({ a: 1, b: 2 }), "a"), lodash.omit(Object.create({ a: 1, b: 2 }), "a"));
  });
});

describe("lodash.keys / values", () => {
  it("returns own enumerable string keys; array-likes include every index", () => {
    assert.deepEqual(keys({ b: 1, a: 2 }), lodash.keys({ b: 1, a: 2 }));
    assert.deepEqual(keys([, 2]), lodash.keys([, 2]));
    assert.deepEqual(keys("hi"), lodash.keys("hi"));
    assert.deepEqual(keys(null), lodash.keys(null));
    assert.deepEqual(keys(1), lodash.keys(1));
    assert.deepEqual(keys(new Map([["a", 1]])), lodash.keys(new Map([["a", 1]])));
    assert.deepEqual(keys({ length: 2, 0: "a", 1: "b" }), lodash.keys({ length: 2, 0: "a", 1: "b" }));
    assert.deepEqual(keys(Object.assign([1, 2], { a: 9 })), lodash.keys(Object.assign([1, 2], { a: 9 })));
  });

  it("values follow keys order", () => {
    assert.deepEqual(values({ b: 1, a: 2 }), lodash.values({ b: 1, a: 2 }));
    assert.deepEqual(values([, 2]), lodash.values([, 2]));
    assert.deepEqual(values("hi"), lodash.values("hi"));
    assert.deepEqual(values(null), lodash.values(null));
    assert.deepEqual(values(Object.assign([1, 2], { a: 9 })), lodash.values(Object.assign([1, 2], { a: 9 })));
  });
});

describe("lodash.assign", () => {
  it("copies own enumerable string keys and mutates the destination", () => {
    const dest = { a: 1 };
    assert.equal(assign(dest, { b: 2 }), dest);
    assert.deepEqual(dest, { a: 1, b: 2 });
    assert.deepEqual(assign({ a: 1 }, null, { b: 2 }), lodash.assign({ a: 1 }, null, { b: 2 }));
    assert.deepEqual(assign({ a: 1 }, { a: 2, b: 3 }), lodash.assign({ a: 1 }, { a: 2, b: 3 }));
  });

  it("does not copy symbols or inherited properties", () => {
    const sym = Symbol("s");
    assert.equal((assign({}, { [sym]: 1 }) as Record<symbol, unknown>)[sym], undefined);
    function Foo(this: { a: number }) {
      this.a = 1;
    }
    Foo.prototype.b = 2;
    assert.deepEqual(assign({ c: 3 }, new (Foo as unknown as new () => { a: number })()), { c: 3, a: 1 });
  });

  it("coerces a null destination to an object", () => {
    assert.deepEqual(assign(null, { a: 1 }), lodash.assign(null, { a: 1 }));
  });
});
