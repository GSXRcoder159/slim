import { test } from "node:test";
import assert from "node:assert/strict";
import { wrapExports } from "../../src/trace/proxy.ts";
import type { TraceEvent } from "../../src/envelope/types.ts";

test("wraps a fake module get export and records a TraceEvent", () => {
  const events: TraceEvent[] = [];
  const mod = {
    get(o: Record<string, unknown>, p: string) {
      return o[p];
    },
  };
  const wrapped = wrapExports(mod, {
    packageName: "lodash",
    onEvent: (e) => events.push(e),
  }) as typeof mod;
  const result = wrapped.get({ a: 1 }, "a");
  assert.equal(result, 1);
  assert.equal(events.length, 1);
  const ev = events[0]!;
  assert.equal(ev.symbol, "get");
  assert.equal(ev.args.length, 2);
  assert.equal(ev.args[0]?.t, "obj");
  assert.equal(ev.args[1]?.t, "str");
  assert.equal(ev.result?.t, "num");
  assert.equal(typeof ev.sessionId, "string");
  assert.equal(typeof ev.tRelMs, "number");
  assert.ok(ev.tRelMs! >= 0);
  assert.equal(ev.threw, undefined);
});

test("cyclic function placeholder keeps export symbols", () => {
  const events: TraceEvent[] = [];
  function lodash(): string {
    return "called";
  }
  function get(o: Record<string, unknown>, p: string): unknown {
    return o[p];
  }
  function bind(): string {
    return "bound";
  }
  (bind as { placeholder: typeof lodash }).placeholder = lodash;
  Object.assign(lodash, { get, bind });
  const wrapped = wrapExports(lodash, {
    packageName: "lodash",
    onEvent: (e) => events.push(e),
  }) as typeof lodash & { get: typeof get; bind: typeof bind };
  assert.equal(wrapped.get({ a: 1 }, "a"), 1);
  assert.equal(events.some((e) => e.symbol === "get"), true);
  assert.equal(
    events.some((e) => e.symbol.includes("placeholder")),
    false,
  );
});

test("does not wrap primitive exports", () => {
  assert.equal(
    wrapExports("hello", { packageName: "x", onEvent: () => {} }),
    "hello",
  );
  assert.equal(
    wrapExports(3, { packageName: "x", onEvent: () => {} }),
    3,
  );
});

test("records threw without result", () => {
  const events: TraceEvent[] = [];
  const mod = {
    boom() {
      const err = new Error("nope") as Error & { code?: string };
      err.name = "TypeError";
      err.code = "ERR_BOOM";
      throw err;
    },
  };
  const wrapped = wrapExports(mod, {
    packageName: "x",
    onEvent: (e) => events.push(e),
  }) as typeof mod;
  assert.throws(() => wrapped.boom());
  assert.equal(events[0]!.threw?.name, "TypeError");
  assert.equal(events[0]!.threw?.message, "nope");
  assert.equal(events[0]!.threw?.code, "ERR_BOOM");
  assert.equal(events[0]!.result, undefined);
});

test("wraps returned function cancel/flush as parent.cancel", () => {
  const events: TraceEvent[] = [];
  const mod = {
    debounce(fn: () => number) {
      function debounced() {
        return fn();
      }
      debounced.cancel = () => "cancelled";
      debounced.flush = () => "flushed";
      return debounced;
    },
  };
  const wrapped = wrapExports(mod, {
    packageName: "lodash",
    onEvent: (e) => events.push(e),
  }) as typeof mod;
  const d = wrapped.debounce(() => 1);
  assert.equal(d.cancel(), "cancelled");
  assert.equal(d.flush(), "flushed");
  const symbols = events.map((e) => e.symbol);
  assert.ok(symbols.includes("debounce"));
  assert.ok(symbols.includes("debounce.cancel"));
  assert.ok(symbols.includes("debounce.flush"));
});

test("mutatedArgIndexes when callee mutates an object arg", () => {
  const events: TraceEvent[] = [];
  const mod = {
    fill(o: { x: number }) {
      o.x = 2;
      return o;
    },
  };
  const wrapped = wrapExports(mod, {
    packageName: "x",
    onEvent: (e) => events.push(e),
  }) as typeof mod;
  wrapped.fill({ x: 1 });
  assert.deepEqual(events[0]!.mutatedArgIndexes, [0]);
});
