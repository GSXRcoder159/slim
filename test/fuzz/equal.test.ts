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
  assert.equal(
    equalThrown(
      { name: "TypeError", message: "Invalid URL", code: "ERR_INVALID_URL" },
      { name: "TypeError", message: "Invalid URL: false" },
    ),
    true,
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

test("equalResults treats catalog proto-hardening as agreement", () => {
  const orig: CallOutcome = {
    ok: true,
    value: { polluted: true },
    argsAfter: [{ polluted: true }, "__proto__"],
  };
  const slim: CallOutcome = {
    ok: true,
    value: {},
    argsAfter: [{}, "__proto__"],
  };
  assert.equal(equalResults(orig, slim).ok, true);
  const stillMismatch: CallOutcome = {
    ok: true,
    value: { a: 1 },
    argsAfter: [{ a: 1 }, "a"],
  };
  const clean: CallOutcome = { ok: true, value: {}, argsAfter: [{}, "a"] };
  assert.equal(equalResults(stillMismatch, clean).ok, false);
});

test("equal ignores own __proto__ keys (catalog hardening vs older lodash.clone)", () => {
  const withProto: Record<string, unknown> = { a: 1 };
  Object.defineProperty(withProto, "__proto__", {
    value: { polluted: true },
    enumerable: true,
    configurable: true,
    writable: true,
  });
  assert.equal(equal(withProto, { a: 1 }), true);
});

test("equalResults treats own __proto__ clone args as hardening (json/prototype hyrum)", () => {
  const src: Record<string, unknown> = { a: 1 };
  Object.defineProperty(src, "__proto__", {
    value: { polluted: true },
    enumerable: true,
    configurable: true,
    writable: true,
  });
  const orig: CallOutcome = {
    ok: true,
    value: Object.assign(Object.create({ polluted: true }), { a: 1 }),
    argsAfter: [src],
  };
  const slimVal: Record<string, unknown> = { a: 1 };
  Object.defineProperty(slimVal, "__proto__", {
    value: { polluted: true },
    enumerable: true,
    configurable: true,
    writable: true,
  });
  const slim: CallOutcome = { ok: true, value: slimVal, argsAfter: [src] };
  assert.equal(equalResults(orig, slim, { json: true, prototype: true }).ok, true);
  const stillMismatch: CallOutcome = {
    ok: true,
    value: { a: 1 },
    argsAfter: [{ a: 1 }],
  };
  const clean: CallOutcome = { ok: true, value: { a: 2 }, argsAfter: [{ a: 1 }] };
  assert.equal(equalResults(stillMismatch, clean, { json: true }).ok, false);
});

test("hardening marker does not hide unrelated return or mutation mismatches", () => {
  const returnMismatch = equalResults(
    { ok: true, value: 1, argsAfter: [{}, "__proto__"] },
    { ok: true, value: 2, argsAfter: [{}, "__proto__"] },
  );
  assert.equal(returnMismatch.ok, false);

  const mutationMismatch = equalResults(
    { ok: true, value: 1, argsAfter: [{ changed: true }, "__proto__"] },
    { ok: true, value: 1, argsAfter: [{}, "__proto__"] },
  );
  assert.equal(mutationMismatch.ok, false);

  const protoAndValueMismatch = equalResults(
    {
      ok: true,
      value: Object.assign(Object.create({ polluted: true }), { a: 1 }),
      argsAfter: [{ a: 1 }, "__proto__"],
    },
    { ok: true, value: { a: 2 }, argsAfter: [{ a: 2 }, "__proto__"] },
    { prototype: true },
  );
  assert.equal(protoAndValueMismatch.ok, false);
});

test("equal ignores slim.protoTag copied by lodash.clone", () => {
  const tagged = { a: 1 };
  Object.defineProperty(tagged, Symbol.for("slim.protoTag"), {
    value: "object",
    enumerable: true,
    configurable: true,
    writable: true,
  });
  assert.equal(equal(tagged, { a: 1 }), true);
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

test("toString is compared on nested objects when hyrum.toString", () => {
  const a = { nested: { x: 1, toString() { return "A"; } } };
  const b = { nested: { x: 1, toString() { return "B"; } } };
  assert.equal(equal(a, b), true);
  assert.equal(equal(a, b, { toString: true }), false);
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

test("invoke preserves args[0] === args[1] and isolates orig from slim", () => {
  const shared = { n: 0 };
  function bumpBoth(a: { n: number }, b: { n: number }) {
    assert.equal(a, b);
    a.n += 1;
    return a.n;
  }
  const a = invoke(bumpBoth, [shared, shared]);
  const b = invoke(bumpBoth, [shared, shared]);
  assert.equal(shared.n, 0);
  assert.equal(a.ok && a.value, 1);
  assert.equal(b.ok && b.value, 1);
  assert.ok(a.ok && b.ok);
  if (!a.ok || !b.ok) return;
  assert.equal(a.argsAfter[0], a.argsAfter[1]);
  assert.equal(b.argsAfter[0], b.argsAfter[1]);
  assert.notEqual(a.argsAfter[0], b.argsAfter[0]);
  assert.notEqual(a.argsAfter[0], shared);
});

test("invoke preserves args[0] === thisArg including cycles across the boundary", () => {
  const recv: { n: number; self?: unknown } = { n: 0 };
  recv.self = recv;
  function bump(this: { n: number; self?: unknown }, x: { n: number; self?: unknown }) {
    assert.equal(this, x);
    assert.equal(this.self, this);
    this.n += 1;
    return this;
  }
  const out = invoke(bump, [recv], recv);
  assert.ok(out.ok);
  if (!out.ok) return;
  assert.equal(out.argsAfter[0], out.thisAfter);
  assert.equal((out.thisAfter as { self: unknown }).self, out.thisAfter);
  assert.equal((out.thisAfter as { n: number }).n, 1);
  assert.equal(recv.n, 0);
});

test("invoke constructor retry and throw keep the cloned alias graph", () => {
  class Pair {
    a: { n: number };
    b: { n: number };
    constructor(a: { n: number }, b: { n: number }) {
      if (new.target === undefined) {
        throw new TypeError("Class constructor Pair cannot be invoked without 'new'");
      }
      assert.equal(a, b);
      this.a = a;
      this.b = b;
    }
  }
  const shared = { n: 1 };
  const constructed = invoke(Pair, [shared, shared]);
  assert.ok(constructed.ok);
  if (!constructed.ok) return;
  assert.equal(constructed.argsAfter[0], constructed.argsAfter[1]);
  const inst = constructed.value as { a: { n: number }; b: { n: number } };
  assert.equal(inst.a, inst.b);
  assert.equal(inst.a, constructed.argsAfter[0]);

  function boom(a: { n: number }, b: { n: number }) {
    a.n += 1;
    assert.equal(a, b);
    throw new TypeError("nope");
  }
  const threw = invoke(boom, [shared, shared]);
  assert.equal(threw.ok, false);
  assert.equal(threw.argsAfter[0], threw.argsAfter[1]);
  assert.equal((threw.argsAfter[0] as { n: number }).n, 2);
  assert.equal(shared.n, 1);
});

test("equalResults fails a replacement that splits a shared arg/receiver alias under mutation", () => {
  const shared = { n: 1 };
  function bumpShared(this: { n: number }, x: { n: number }) {
    this.n += 1;
    return x.n;
  }
  const good = equalResults(invoke(bumpShared, [shared], shared), invoke(bumpShared, [shared], shared), {
    mutation: true,
  });
  assert.equal(good.ok, true);

  const origShared = { n: 1 };
  const orig: CallOutcome = { ok: true, value: 1, argsAfter: [origShared], thisAfter: origShared };
  const slim: CallOutcome = { ok: true, value: 1, argsAfter: [{ n: 1 }], thisAfter: { n: 1 } };
  const bad = equalResults(orig, slim, { mutation: true });
  assert.equal(bad.ok, false);
  assert.match(bad.reason ?? "", /mutation/i);
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
