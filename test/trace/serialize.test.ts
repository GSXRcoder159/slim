import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deserialize,
  mutatedArgIndexes,
  serialize,
  snapshot,
} from "../../src/trace/serialize.ts";
import type { SlimValue } from "../../src/envelope/types.ts";

test("tags NaN, -0, Infinity, -Infinity", () => {
  assert.deepEqual(serialize(NaN), { t: "num", v: "NaN" });
  assert.deepEqual(serialize(-0), { t: "num", v: "-0" });
  assert.deepEqual(serialize(Infinity), { t: "num", v: "Infinity" });
  assert.deepEqual(serialize(-Infinity), { t: "num", v: "-Infinity" });
  assert.ok(Number.isNaN(deserialize({ t: "num", v: "NaN" })));
  assert.ok(Object.is(deserialize({ t: "num", v: "-0" }), -0));
  assert.equal(deserialize({ t: "num", v: "Infinity" }), Infinity);
  assert.equal(deserialize({ t: "num", v: "-Infinity" }), -Infinity);
});

test("cycles become ref to the first-seen object id", () => {
  const o: { a: number; self?: unknown } = { a: 1 };
  o.self = o;
  const s = serialize(o);
  assert.equal(s.t, "obj");
  if (s.t !== "obj") throw new Error("expected obj");
  assert.deepEqual(s.v.self, { t: "ref", id: 0 });
  const back = deserialize(s) as { a: number; self: unknown };
  assert.equal(back.self, back);
  assert.equal(back.a, 1);
});

test("array self-cycle uses ref", () => {
  const a: unknown[] = [];
  a.push(a);
  const s = serialize(a);
  assert.equal(s.t, "arr");
  if (s.t !== "arr") throw new Error("expected arr");
  assert.deepEqual(s.v[0], { t: "ref", id: 0 });
});

test("error has name, message, optional code, and no stack", () => {
  const err = new Error("boom") as Error & { code?: string };
  err.code = "ERR_SLIM";
  const s = serialize(err);
  assert.equal(s.t, "err");
  if (s.t !== "err") throw new Error("expected err");
  assert.equal(s.name, "Error");
  assert.equal(s.message, "boom");
  assert.equal(s.code, "ERR_SLIM");
  assert.equal("stack" in s, false);
  assert.equal(JSON.stringify(s).includes("stack"), false);
});

test("redacts strings matching password|token|secret|authorization", () => {
  const secret = serialize("super-secret-value");
  assert.equal(secret.t, "str");
  if (secret.t !== "str") throw new Error("expected str");
  assert.equal(secret.redacted, true);
  assert.equal(secret.v, "[redacted]");

  const keyed = serialize({ password: "hunter2", ok: "fine" });
  assert.equal(keyed.t, "obj");
  if (keyed.t !== "obj") throw new Error("expected obj");
  assert.deepEqual(keyed.v.password, {
    t: "str",
    v: "[redacted]",
    redacted: true,
  });
  assert.deepEqual(keyed.v.ok, { t: "str", v: "fine" });
});

test("does not await promises", () => {
  let started = false;
  const p = new Promise((resolve) => {
    started = true;
    resolve("never-read");
  });
  const s = serialize(p);
  assert.deepEqual(s, { t: "promise" });
  assert.equal(s.t, "promise");
  void started;
});

test("truncates strings over 4KiB and appends sha256", () => {
  const big = "z".repeat(5000);
  const s = serialize(big);
  assert.equal(s.t, "str");
  if (s.t !== "str") throw new Error("expected str");
  assert.ok(s.v.startsWith("z".repeat(4096)));
  assert.match(s.v, /\nsha256:[0-9a-f]{64}$/);
  assert.equal(s.redacted, undefined);
});

test("functions never include a body", () => {
  function hidden() {
    return "BODY_SHOULD_NOT_APPEAR";
  }
  const s = serialize(hidden);
  assert.equal(s.t, "fn");
  if (s.t !== "fn") throw new Error("expected fn");
  assert.equal(s.name, "hidden");
  assert.equal(JSON.stringify(s).includes("BODY_SHOULD_NOT_APPEAR"), false);
  const fn = deserialize(s);
  assert.equal(typeof fn, "function");
  assert.equal((fn as () => unknown)(), undefined);
});

test("dates, maps, sets, and short Uint8Array", () => {
  const d = new Date("2020-01-02T00:00:00.000Z");
  assert.deepEqual(serialize(d), { t: "date", v: d.getTime() });
  const m = serialize(new Map([["a", 1]]));
  assert.equal(m.t, "map");
  const set = serialize(new Set([1, 2]));
  assert.equal(set.t, "set");
  const bytes = serialize(Uint8Array.from([1, 2, 3]));
  assert.equal(bytes.t, "bytes");
  if (bytes.t !== "bytes") throw new Error("expected bytes");
  assert.equal(bytes.kind, "u8");
  assert.equal(bytes.len, 3);
  assert.equal(typeof bytes.b64, "string");
});

test("snapshot and mutatedArgIndexes detect structural mutation", () => {
  const obj = { n: 1 };
  const before = snapshot([obj, "ok"]);
  obj.n = 2;
  const after = snapshot([obj, "ok"]);
  assert.deepEqual(mutatedArgIndexes(before, after), [0]);
  assert.deepEqual(mutatedArgIndexes(before, before), []);
});

test("sparse array holes are recorded", () => {
  const a = [1, , 3];
  const s = serialize(a);
  assert.equal(s.t, "arr");
  if (s.t !== "arr") throw new Error("expected arr");
  assert.deepEqual(s.holes, [1]);
});

test("primitives", () => {
  assert.deepEqual(serialize(undefined), { t: "undef" });
  assert.deepEqual(serialize(null), { t: "null" });
  assert.deepEqual(serialize(true), { t: "bool", v: true });
  assert.deepEqual(serialize(3), { t: "num", v: 3 });
  assert.deepEqual(serialize("hi"), { t: "str", v: "hi" });
  assert.deepEqual(serialize(1n), { t: "bigint", v: "1" });
});

test("deserialize round-trips a tagged value", () => {
  const v: SlimValue = { t: "obj", keys: ["x"], v: { x: { t: "num", v: 1 } } };
  assert.deepEqual(deserialize(v), { x: 1 });
});
