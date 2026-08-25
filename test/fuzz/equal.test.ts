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
  assert.equal(equal(new Set([1, 2, 3]), new Set([3, 1, 2])), true);
  assert.equal(equal(new Set([1]), new Set([1, 2])), false);
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
});
