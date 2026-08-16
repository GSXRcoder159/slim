import assert from "node:assert/strict";
import { describe, it } from "node:test";
import lodash from "lodash";
import { isEmpty } from "../../src/generate/catalog/lodash.isEmpty.ts";
import { isNil } from "../../src/generate/catalog/lodash.isNil.ts";
import { isEqual } from "../../src/generate/catalog/lodash.isEqual.ts";
import { clone } from "../../src/generate/catalog/lodash.clone.ts";
import { cloneDeep } from "../../src/generate/catalog/lodash.cloneDeep.ts";

describe("lodash.isNil", () => {
  it("is true only for null and undefined", () => {
    for (const v of [null, undefined, 0, false, "", NaN, {}, []]) {
      assert.equal(isNil(v), lodash.isNil(v), String(v));
    }
  });
});

describe("lodash.isEmpty", () => {
  it("treats non-collections as empty", () => {
    assert.equal(isEmpty(0), true);
    assert.equal(isEmpty(true), true);
    assert.equal(isEmpty(null), true);
    for (const v of [null, undefined, true, false, 0, 1, "", "a", [], [1], {}, { a: 1 }, new Date()]) {
      assert.equal(isEmpty(v), lodash.isEmpty(v), String(v));
    }
  });

  it("uses size for Map and Set", () => {
    assert.equal(isEmpty(new Map()), true);
    assert.equal(isEmpty(new Map([[1, 2]])), false);
    assert.equal(isEmpty(new Set()), true);
    assert.equal(isEmpty(new Set([1])), false);
    assert.equal(isEmpty(new Map()), lodash.isEmpty(new Map()));
    assert.equal(isEmpty(new Set([1])), lodash.isEmpty(new Set([1])));
  });

  it("does not treat {length:0} as an empty collection unless it looks jQuery-like", () => {
    assert.equal(isEmpty({ length: 0 }), lodash.isEmpty({ length: 0 }));
    assert.equal(isEmpty({ length: 0, a: 1 }), lodash.isEmpty({ length: 0, a: 1 }));
    assert.equal(
      isEmpty({ length: 0, splice: function splice() {} }),
      lodash.isEmpty({ length: 0, splice: function splice() {} }),
    );
  });

  it("handles buffers, typed arrays, arguments, and string objects", () => {
    assert.equal(isEmpty(Buffer.alloc(0)), lodash.isEmpty(Buffer.alloc(0)));
    assert.equal(isEmpty(Buffer.from("a")), lodash.isEmpty(Buffer.from("a")));
    assert.equal(isEmpty(new Uint8Array(0)), lodash.isEmpty(new Uint8Array(0)));
    assert.equal(isEmpty(new String("")), lodash.isEmpty(new String("")));
    assert.equal(isEmpty(new String("a")), lodash.isEmpty(new String("a")));
    assert.equal(isEmpty(function emptyArgs() { return arguments; }()), true);
  });
});

describe("lodash.isEqual", () => {
  it("deep-compares objects, arrays, NaN, and dates", () => {
    assert.equal(isEqual({ a: 1 }, { a: 1 }), true);
    assert.equal(isEqual({ a: 1 }, { a: 2 }), false);
    assert.equal(isEqual(NaN, NaN), true);
    assert.equal(isEqual(+0, -0), true);
    assert.equal(isEqual(null, undefined), false);
    assert.equal(isEqual(new Date(1), new Date(1)), true);
    assert.equal(isEqual(new Date(NaN), new Date(NaN)), true);
    assert.equal(isEqual([1, , 3], [1, undefined, 3]), true);
    assert.equal(isEqual([1], { 0: 1, length: 1 }), false);
    assert.equal(isEqual(1, new Number(1)), true);
  });

  it("handles cycles, maps, sets, regexes, and errors", () => {
    const a: { x: number; self?: unknown } = { x: 1 };
    a.self = a;
    const b: { x: number; self?: unknown } = { x: 1 };
    b.self = b;
    assert.equal(isEqual(a, b), true);
    assert.equal(isEqual(new Map([["a", 1]]), new Map([["a", 1]])), true);
    assert.equal(isEqual(new Set([1, 2]), new Set([2, 1])), true);
    assert.equal(isEqual(new Map([[{ a: 1 }, 1]]), new Map([[{ a: 1 }, 1]])), true);
    assert.equal(isEqual(/a/g, /a/g), true);
    assert.equal(isEqual(/a/g, /a/i), false);
    assert.equal(isEqual(new Error("a"), new Error("a")), true);
    assert.equal(isEqual(new Error("a"), new Error("b")), false);
  });

  it("matches lodash on a sample of pairs", () => {
    const pairs: [unknown, unknown][] = [
      [{ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }],
      [[1, 2, 3], [1, 2, 3]],
      [new Date(0), new Date(0)],
      [NaN, NaN],
      [new Uint8Array([1, 2]), new Uint8Array([1, 2])],
    ];
    for (const [x, y] of pairs) {
      assert.equal(isEqual(x, y), lodash.isEqual(x, y));
    }
  });

  it("ignores extra enumerable properties on arrays (lodash 4)", () => {
    const a = [1] as number[] & { x?: number };
    a.x = 2;
    assert.equal(isEqual(a, [1]), lodash.isEqual(a, [1]));
  });
});

describe("lodash.clone / cloneDeep", () => {
  it("clone is shallow; cloneDeep is not", () => {
    const objects = [{ a: 1 }, { b: 2 }];
    assert.equal(clone(objects)[0], objects[0]);
    assert.notEqual(cloneDeep(objects)[0], objects[0]);
    assert.deepEqual(cloneDeep(objects), objects);
  });

  it("cloneDeep handles cycles, dates, maps, and sets", () => {
    const cyc: { n: number; self?: unknown } = { n: 1 };
    cyc.self = cyc;
    const deep = cloneDeep(cyc);
    assert.notEqual(deep, cyc);
    assert.equal(deep.self, deep);
    assert.equal(deep.n, 1);

    const d = new Date(5);
    const cd = cloneDeep(d);
    assert.ok(cd instanceof Date);
    assert.equal(cd.getTime(), 5);
    assert.notEqual(cd, d);

    const src = new Map([[{ a: 1 }, { b: 2 }]]);
    const mapped = cloneDeep(src);
    assert.equal(lodash.isEqual(mapped, src), true);
    assert.notEqual([...mapped.keys()][0], [...src.keys()][0]);

    const setSrc = new Set([{ a: 1 }]);
    const setClone = cloneDeep(setSrc);
    assert.notEqual([...setClone][0], [...setSrc][0]);
  });

  it("does not pollute Object.prototype when cloning __proto__ keys", () => {
    const src = JSON.parse('{"__proto__":{"polluted":true}}') as object;
    cloneDeep(src);
    clone(src);
    assert.equal(({} as { polluted?: boolean }).polluted, undefined);
  });

  it("returns {} for functions and preserves class prototypes", () => {
    assert.deepEqual(clone(() => 1), {});
    class Foo {
      a = 1;
    }
    const f = cloneDeep(new Foo());
    assert.ok(f instanceof Foo);
    assert.equal(f.a, 1);
  });

  it("clones regex lastIndex and array holes", () => {
    const r = /a/g;
    r.lastIndex = 3;
    const rc = clone(r);
    assert.equal(rc.source, "a");
    assert.equal(rc.flags, "g");
    assert.equal(rc.lastIndex, 3);
    const sparse = [, 1] as unknown[];
    const cs = cloneDeep(sparse);
    assert.equal(0 in cs, false);
    assert.equal(cs[1], 1);
  });
});
