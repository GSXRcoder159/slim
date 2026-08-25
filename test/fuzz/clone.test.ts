import { test } from "node:test";
import assert from "node:assert/strict";
import { clone } from "../../src/fuzz/clone.ts";
import { equal } from "../../src/fuzz/equal.ts";

test("primitives and functions are returned as-is", () => {
  assert.equal(clone(1), 1);
  assert.equal(clone("hi"), "hi");
  assert.equal(clone(null), null);
  assert.equal(clone(undefined), undefined);
  const f = () => 1;
  assert.equal(clone(f), f);
});

test("Date is cloned by time, not identity", () => {
  const d = new Date("2020-01-02T03:04:05.000Z");
  const c = clone(d);
  assert.ok(c instanceof Date);
  assert.notEqual(c, d);
  assert.equal(c.getTime(), d.getTime());
});

test("Map and Set clone contents", () => {
  const m = new Map<unknown, unknown>([["a", { n: 1 }]]);
  const cm = clone(m);
  assert.ok(cm instanceof Map);
  assert.notEqual(cm, m);
  assert.equal((cm.get("a") as { n: number }).n, 1);
  (m.get("a") as { n: number }).n = 9;
  assert.equal((cm.get("a") as { n: number }).n, 1);

  const s = new Set([{ n: 1 }]);
  const cs = clone(s);
  assert.equal(cs.size, 1);
  assert.notEqual([...cs][0], [...s][0]);
});

test("sparse arrays preserve holes", () => {
  const a = new Array(4);
  a[2] = { x: 1 };
  const c = clone(a);
  assert.equal(c.length, 4);
  assert.equal(0 in c, false);
  assert.equal(1 in c, false);
  assert.equal(2 in c, true);
  assert.equal(3 in c, false);
  assert.notEqual(c[2], a[2]);
  assert.equal((c[2] as { x: number }).x, 1);
});

test("cycles clone via WeakMap and remain cyclic", () => {
  const a: { self?: unknown; n: number } = { n: 1 };
  a.self = a;
  const c = clone(a) as { self?: unknown; n: number };
  assert.notEqual(c, a);
  assert.equal(c.self, c);
  assert.equal(c.n, 1);
  assert.equal(equal(a, c), true);
});

test("own __proto__ constructor prototype keys do not mutate Object.prototype", () => {
  const src = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(src, "__proto__", {
    value: { polluted: true },
    enumerable: true,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(src, "constructor", {
    value: 1,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(src, "prototype", {
    value: 2,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  const before = Object.prototype.hasOwnProperty("polluted");
  const c = clone(src);
  assert.equal(Object.prototype.hasOwnProperty("polluted"), before);
  assert.equal(Object.getOwnPropertyDescriptor(c, "__proto__")?.value?.polluted, true);
  assert.equal((c as Record<string, unknown>).constructor, 1);
  assert.equal((c as Record<string, unknown>).prototype, 2);
});

test("Error, Buffer, and Uint8Array", () => {
  const e = new TypeError("Expected a function");
  (e as Error & { code?: string }).code = "ERR_INVALID_ARG_TYPE";
  const ce = clone(e);
  assert.ok(ce instanceof Error);
  assert.notEqual(ce, e);
  assert.equal(ce.name, "TypeError");
  assert.equal(ce.message, "Expected a function");
  assert.equal((ce as Error & { code?: string }).code, "ERR_INVALID_ARG_TYPE");

  const buf = Buffer.from([1, 2, 3]);
  const cb = clone(buf);
  assert.ok(Buffer.isBuffer(cb));
  assert.notEqual(cb, buf);
  assert.ok(cb.equals(buf));
  buf[0] = 9;
  assert.equal(cb[0], 1);

  const u = new Uint8Array([4, 5]);
  const cu = clone(u);
  assert.ok(cu instanceof Uint8Array);
  assert.notEqual(cu, u);
  assert.deepEqual([...cu], [4, 5]);
});

test("plain objects and nested arrays", () => {
  const o = { a: [1, { b: 2 }], c: true };
  const c = clone(o);
  assert.notEqual(c, o);
  assert.notEqual(c.a, o.a);
  assert.equal(equal(o, c), true);
  (c.a[1] as { b: number }).b = 3;
  assert.equal((o.a[1] as { b: number }).b, 2);
});
