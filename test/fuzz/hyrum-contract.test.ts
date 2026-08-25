import { test } from "node:test";
import assert from "node:assert/strict";
import { clone } from "../../src/fuzz/clone.ts";
import { equal, equalResults, invoke } from "../../src/fuzz/equal.ts";
import { deserializeEvent, serialize, serializeEvent } from "../../src/trace/serialize.ts";
import { emptyHyrum } from "../../src/envelope/types.ts";

test("every public Hyrum flag is read by equal/equalResults", () => {
  const flags = emptyHyrum();
  for (const k of Object.keys(flags) as (keyof typeof flags)[]) {
    const on = { ...emptyHyrum(), [k]: true };
    equal(1, 1, on);
    equalResults(invoke((x: number) => x, [1]), invoke((x: number) => x, [1]), on);
  }
  assert.deepEqual(Object.keys(flags).sort(), [
    "dateIdentity",
    "errorMessage",
    "json",
    "keyOrder",
    "mutation",
    "nan",
    "prototype",
    "sameReference",
    "signedZero",
    "sparseArray",
    "toString",
  ]);
});

test("known-bad replacements fail when the corresponding Hyrum flag is observed", () => {
  const nested = { n: 1 };
  const root = { nested };
  const ident = (o: { nested: { n: number } }) => o.nested;
  const cloned = (o: { nested: { n: number } }) => ({ ...o.nested });
  assert.equal(equalResults(invoke(ident, [root]), invoke(ident, [root]), { sameReference: true }).ok, true);
  assert.equal(equalResults(invoke(ident, [root]), invoke(cloned, [root]), { sameReference: true }).ok, false);

  const proto = { p: true };
  const withProto = () => Object.assign(Object.create(proto), { x: 1 });
  const stripped = () => Object.assign({}, { x: 1 });
  assert.equal(equalResults(invoke(withProto, []), invoke(withProto, []), { prototype: true }).ok, true);
  assert.equal(equalResults(invoke(withProto, []), invoke(stripped, []), { prototype: true }).ok, false);

  const d = new Date("2020-01-02T00:00:00.000Z");
  const sameDate = (x: Date) => x;
  const copyDate = (x: Date) => new Date(x.getTime());
  assert.equal(equalResults(invoke(sameDate, [d]), invoke(sameDate, [d]), { dateIdentity: true }).ok, true);
  assert.equal(equalResults(invoke(sameDate, [d]), invoke(copyDate, [d]), { dateIdentity: true }).ok, false);

  function bumpArg(obj: { n: number }) {
    obj.n += 1;
    return obj.n;
  }
  function skipArg(obj: { n: number }) {
    return obj.n + 1;
  }
  assert.equal(equalResults(invoke(bumpArg, [{ n: 0 }]), invoke(bumpArg, [{ n: 0 }]), { mutation: true }).ok, true);
  assert.equal(equalResults(invoke(bumpArg, [{ n: 0 }]), invoke(skipArg, [{ n: 0 }]), { mutation: true }).ok, false);

  function bumpThis(this: { n: number }) {
    this.n += 1;
    return this.n;
  }
  function skipThis(this: { n: number }) {
    return this.n + 1;
  }
  assert.equal(equalResults(invoke(bumpThis, [], { n: 0 }), invoke(bumpThis, [], { n: 0 }), { mutation: true }).ok, true);
  assert.equal(equalResults(invoke(bumpThis, [], { n: 0 }), invoke(skipThis, [], { n: 0 }), { mutation: true }).ok, false);

  assert.equal(equalResults(invoke(() => NaN, []), invoke(() => NaN, []), { nan: true }).ok, true);
  assert.equal(equalResults(invoke(() => NaN, []), invoke(() => 0, []), { nan: true }).ok, false);

  assert.equal(equalResults(invoke(() => -0, []), invoke(() => -0, []), { signedZero: true }).ok, true);
  assert.equal(equalResults(invoke(() => -0, []), invoke(() => 0, []), { signedZero: true }).ok, false);

  const sparse = () => {
    const a = new Array(3);
    a[1] = 1;
    return a;
  };
  const dense = () => [undefined, 1, undefined];
  assert.equal(equalResults(invoke(sparse, []), invoke(sparse, []), { sparseArray: true }).ok, true);
  assert.equal(equalResults(invoke(sparse, []), invoke(dense, []), { sparseArray: true }).ok, false);

  const sym = Symbol("k");
  const withSym = () => ({ [sym]: 1, x: 2 });
  const dropSym = () => ({ x: 2 });
  assert.equal(equalResults(invoke(withSym, []), invoke(withSym, [])).ok, true);
  assert.equal(equalResults(invoke(withSym, []), invoke(dropSym, [])).ok, false);

  const ordered = () => ({ x: 1, y: 2 });
  const swapped = () => ({ y: 2, x: 1 });
  assert.equal(equalResults(invoke(ordered, []), invoke(swapped, [])).ok, true);
  assert.equal(equalResults(invoke(ordered, []), invoke(swapped, []), { keyOrder: true }).ok, false);

  const boom = () => {
    const e = new TypeError("Expected a function") as Error & { code?: string };
    e.code = "ERR";
    throw e;
  };
  const wrongMsg = () => {
    throw new TypeError("nope");
  };
  assert.equal(equalResults(invoke(boom, []), invoke(boom, []), { errorMessage: true }).ok, true);
  assert.equal(equalResults(invoke(boom, []), invoke(wrongMsg, []), { errorMessage: true }).ok, false);

  const aToStr = () => ({ x: 1, toString() { return "A"; } });
  const bToStr = () => ({ x: 1, toString() { return "B"; } });
  assert.equal(equalResults(invoke(aToStr, []), invoke(aToStr, []), { toString: true }).ok, true);
  assert.equal(equalResults(invoke(aToStr, []), invoke(bToStr, []), { toString: true }).ok, false);

  const aJson = () => ({ x: 1, toJSON() { return { k: 1 }; } });
  const bJson = () => ({ x: 1, toJSON() { return { k: 2 }; } });
  assert.equal(equalResults(invoke(aJson, []), invoke(aJson, []), { json: true }).ok, true);
  assert.equal(equalResults(invoke(aJson, []), invoke(bJson, []), { json: true }).ok, false);
});

test("Map and Set order-sensitive and order-insensitive cases", () => {
  const m1 = new Map([["a", 1], ["b", 2]]);
  const m2 = new Map([["b", 2], ["a", 1]]);
  assert.equal(equal(m1, m2), true);
  assert.equal(equal(m1, m2, { keyOrder: true }), false);
  const s1 = new Set([1, 2, 3]);
  const s2 = new Set([3, 1, 2]);
  assert.equal(equal(s1, s2), true);
  assert.equal(equal(s1, s2, { keyOrder: true }), false);
});

test("cyclic aliased values serialize hydrate clone invoke and compare", () => {
  const a: { n: number; self?: unknown; alias?: unknown } = { n: 1 };
  a.self = a;
  a.alias = a;
  const ev = serializeEvent({ args: [a], result: a });
  assert.equal(ev.result?.t, "ref");
  const back = deserializeEvent(ev);
  assert.equal(back.result, back.args[0]);
  const c = clone(a);
  assert.equal(c.self, c);
  assert.equal(c.alias, c);
  assert.equal(equal(a, c), true);
  const ident = (x: unknown) => x;
  const broken = (x: { n: number }) => ({ n: x.n, self: { n: x.n }, alias: { n: x.n } });
  assert.equal(equalResults(invoke(ident, [a]), invoke(ident, [a]), { sameReference: true }).ok, true);
  assert.equal(equalResults(invoke(ident, [a]), invoke(broken, [a]), { sameReference: true }).ok, false);
});

test("serialize hydrate clone standing revive never mutate Object.prototype", () => {
  const src = Object.create(null) as Record<string, unknown>;
  for (const key of ["__proto__", "constructor", "prototype"]) {
    Object.defineProperty(src, key, {
      value: { polluted: true },
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  const before = Object.prototype.hasOwnProperty("polluted");
  const s = serialize(src);
  deserializeEvent({ args: [s], result: s });
  clone(src);
  assert.equal(Object.prototype.hasOwnProperty("polluted"), before);
});
