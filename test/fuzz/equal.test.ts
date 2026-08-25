import { test } from "node:test";
import assert from "node:assert/strict";
import { clone } from "../../src/fuzz/clone.ts";
import {
  equal,
  equalThrown,
  equalResults,
  invoke,
  type CallOutcome,
} from "../../src/fuzz/equal.ts";

test("NaN equals NaN", () => {
  assert.equal(equal(NaN, NaN), true);
  assert.equal(equal({ x: NaN }, { x: Number.NaN }), true);
});

test("-0 equals +0 by default (SameValueZero)", () => {
  assert.equal(equal(-0, 0), true);
  assert.equal(equal([-0], [0]), true);
});

test("-0 distinguished when signedZero is true", () => {
  assert.equal(equal(-0, 0, undefined, { signedZero: true }), false);
  assert.equal(equal(-0, -0, undefined, { signedZero: true }), true);
  assert.equal(equal(0, 0, undefined, { signedZero: true }), true);
});

test("-0 distinguished when hyrum.signedZero is true", () => {
  assert.equal(equal(-0, 0, { signedZero: true }), false);
  assert.equal(equal(-0, -0, { signedZero: true }), true);
  assert.equal(equal(0, 0, { signedZero: true }), true);
  assert.equal(equal(-0, 0, { signedZero: false }), true);
});

test("sparse arrays: holes must match", () => {
  const a = new Array(3);
  a[1] = 1;
  const b = new Array(3);
  b[1] = 1;
  const dense = [undefined, 1, undefined];
  assert.equal(equal(a, b), true);
  assert.equal(equal(a, dense), false);
  const c = new Array(3);
  c[0] = 1;
  assert.equal(equal(a, c), false);
});

test("thrown errors compared as name, message, code", () => {
  assert.equal(
    equalThrown(
      { name: "TypeError", message: "Expected a function", code: "ERR" },
      { name: "TypeError", message: "Expected a function", code: "ERR" },
    ),
    true,
  );
  assert.equal(
    equalThrown(
      { name: "TypeError", message: "Expected a function" },
      { name: "Error", message: "Expected a function" },
    ),
    false,
  );
  assert.equal(
    equalThrown(
      { name: "TypeError", message: "a", code: 1 },
      { name: "TypeError", message: "a", code: 2 },
    ),
    false,
  );
});

test("Date compared by getTime", () => {
  const t = Date.UTC(2020, 0, 2, 3, 4, 5);
  assert.equal(equal(new Date(t), new Date(t)), true);
  assert.equal(equal(new Date(t), new Date(t + 1)), false);
});

test("same-shape cycles are equal", () => {
  const a: { self?: unknown; n: number } = { n: 1 };
  a.self = a;
  const b: { self?: unknown; n: number } = { n: 1 };
  b.self = b;
  assert.equal(equal(a, b), true);
  const c: { self?: unknown; n: number } = { n: 2 };
  c.self = c;
  assert.equal(equal(a, c), false);
  const d: { self?: unknown; n: number; other?: unknown } = { n: 1 };
  d.self = d;
  d.other = d;
  assert.equal(equal(a, d), false);
});

test("Map and Set compared by contents", () => {
  assert.equal(
    equal(
      new Map([["a", 1], ["b", 2]]),
      new Map([["a", 1], ["b", 2]]),
    ),
    true,
  );
  assert.equal(
    equal(
      new Map([["a", 1], ["b", 2]]),
      new Map([["b", 2], ["a", 1]]),
    ),
    true,
  );
  assert.equal(equal(new Set([1, 2, 3]), new Set([3, 1, 2])), true);
  assert.equal(equal(new Set([1]), new Set([1, 2])), false);
});

test("Map and Set insertion order compared only if hyrum.keyOrder", () => {
  const m1 = new Map([["a", 1], ["b", 2]]);
  const m2 = new Map([["b", 2], ["a", 1]]);
  assert.equal(equal(m1, m2), true);
  assert.equal(equal(m1, m2, { keyOrder: true }), false);
  const s1 = new Set([1, 2]);
  const s2 = new Set([2, 1]);
  assert.equal(equal(s1, s2), true);
  assert.equal(equal(s1, s2, { keyOrder: true }), false);
});

test("key order compared only if hyrum.keyOrder", () => {
  const a = { x: 1, y: 2 };
  const b = { y: 2, x: 1 };
  assert.equal(equal(a, b), true);
  assert.equal(equal(a, b, { keyOrder: true }), false);
  assert.equal(equal(a, b, undefined, { keyOrder: true }), false);
  assert.equal(equal({ x: 1, y: 2 }, { x: 1, y: 2 }, { keyOrder: true }), true);
});

test("functions: same ref or name+length", () => {
  const f = function named(a: number, b: number) {
    return a + b;
  };
  assert.equal(equal(f, f), true);
  const g = function named(a: number, b: number) {
    return a * b;
  };
  assert.equal(equal(f, g), true);
  const h = function other(a: number, b: number) {
    return a + b;
  };
  assert.equal(equal(f, h), false);
});

test("mutations of cloned args are visible to equal", () => {
  const args: unknown[] = [{ a: 1, nested: { b: 2 } }];
  const origClone = clone(args) as [{ a: number; nested: { b: number } }];
  const slimClone = clone(args) as [{ a: number; nested: { b: number } }];
  assert.equal(equal(origClone, slimClone), true);
  origClone[0].nested.b = 99;
  assert.equal(equal(origClone, slimClone), false);
  assert.equal(equal(args, slimClone), true);
});

test("equalResults compares returns, throws, and arg mutations", () => {
  const ok = (value: unknown, argsAfter: unknown[] = []): CallOutcome => ({
    ok: true,
    value,
    argsAfter,
  });
  const err = (
    error: { name: string; message: string; code?: unknown },
    argsAfter: unknown[] = [],
  ): CallOutcome => ({ ok: false, error, argsAfter });

  assert.equal(equalResults(ok(1), ok(1)).ok, true);
  assert.equal(equalResults(ok(NaN), ok(NaN)).ok, true);
  assert.equal(equalResults(ok(1), ok(2)).ok, false);

  const threw = err({ name: "TypeError", message: "Expected a function" });
  assert.equal(equalResults(threw, threw).ok, true);
  assert.equal(equalResults(ok(1), threw).ok, false);

  const mutated: CallOutcome = ok("x", [{ n: 2 }]);
  const clean: CallOutcome = ok("x", [{ n: 1 }]);
  assert.equal(equalResults(mutated, clean).ok, false);
  assert.match(equalResults(mutated, clean).reason ?? "", /mutation/i);
});

test("invoke clones thisArg so orig cannot mutate slim's receiver", () => {
  const recv = { n: 0 };
  function bump(this: { n: number }) {
    this.n += 1;
    return this.n;
  }
  const a = invoke(bump, [], recv);
  const b = invoke(bump, [], recv);
  assert.equal(a.ok && a.value, 1);
  assert.equal(b.ok && b.value, 1);
  assert.equal(recv.n, 0);
  assert.equal(a.ok && (a.thisAfter as { n: number }).n, 1);
  assert.equal(recv.n, 0);
});

test("prototype compared only if hyrum.prototype", () => {
  const plain = { x: 1 };
  const nulled = Object.assign(Object.create(null), { x: 1 });
  assert.equal(equal(plain, nulled), true);
  assert.equal(equal(plain, nulled, { prototype: true }), false);
  const proto = { p: 1 };
  const a = Object.assign(Object.create(proto), { x: 1 });
  const b = Object.assign(Object.create(proto), { x: 1 });
  assert.equal(equal(a, b, { prototype: true }), true);
});

test("toString compared only if hyrum.toString", () => {
  const a = { x: 1, toString() { return "A"; } };
  const b = { x: 1, toString() { return "B"; } };
  assert.equal(equal(a, b), true);
  assert.equal(equal(a, b, { toString: true }), false);
  assert.equal(equal(a, { x: 1, toString() { return "A"; } }, { toString: true }), true);
});

test("json compared only if hyrum.json", () => {
  const a = { x: 1, hidden: undefined };
  const b = { x: 1 };
  assert.equal(equal(a, b), false);
  const extra = { x: 1, y: 2 };
  const orig = { x: 1 };
  assert.equal(equal(orig, extra), false);
  const c = { x: 1, toJSON() { return { k: 1 }; } };
  const d = { x: 1, toJSON() { return { k: 2 }; } };
  assert.equal(equal(c, d), true);
  assert.equal(equal(c, d, { json: true }), false);
});

test("enumerable symbol keys are compared", () => {
  const s = Symbol("k");
  const a = { [s]: 1, x: 2 };
  const b = { [s]: 1, x: 2 };
  const c = { [s]: 9, x: 2 };
  const d = { x: 2 };
  assert.equal(equal(a, b), true);
  assert.equal(equal(a, c), false);
  assert.equal(equal(a, d), false);
});

test("sameReference: clone of nested return fails equalResults", () => {
  const nested = { n: 1 };
  const root = { nested };
  function get(obj: { nested: { n: number } }) {
    return obj.nested;
  }
  function getClone(obj: { nested: { n: number } }) {
    return { ...obj.nested };
  }
  const good = equalResults(invoke(get, [root]), invoke(get, [root]), { sameReference: true });
  const bad = equalResults(invoke(get, [root]), invoke(getClone, [root]), { sameReference: true });
  assert.equal(good.ok, true);
  assert.equal(bad.ok, false);
  const cloneOkWithoutFlag = equalResults(invoke(get, [root]), invoke(getClone, [root]));
  assert.equal(cloneOkWithoutFlag.ok, true);
});

test("dateIdentity: new Date with same time fails when input Date was returned", () => {
  const d = new Date("2020-01-02T00:00:00.000Z");
  function ident(x: Date) {
    return x;
  }
  function copy(x: Date) {
    return new Date(x.getTime());
  }
  assert.equal(equalResults(invoke(ident, [d]), invoke(ident, [d]), { dateIdentity: true }).ok, true);
  assert.equal(equalResults(invoke(ident, [d]), invoke(copy, [d]), { dateIdentity: true }).ok, false);
  assert.equal(equalResults(invoke(ident, [d]), invoke(copy, [d])).ok, true);
});

test("receiver mutation is compared by equalResults", () => {
  function bump(this: { n: number }) {
    this.n += 1;
    return this.n;
  }
  function skip(this: { n: number }) {
    return this.n + 1;
  }
  const recv = { n: 0 };
  const good = equalResults(invoke(bump, [], recv), invoke(bump, [], recv), { mutation: true });
  const bad = equalResults(invoke(bump, [], recv), invoke(skip, [], recv), { mutation: true });
  assert.equal(good.ok, true);
  assert.equal(bad.ok, false);
  assert.match(bad.reason ?? "", /receiver mutation/i);
});

test("NaN vs 0 fails (hyrum.nan referenced)", () => {
  assert.equal(equal(NaN, 0, { nan: true }), false);
  assert.equal(equal(NaN, NaN, { nan: true }), true);
});
