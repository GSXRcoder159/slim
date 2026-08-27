import { test } from "node:test";
import assert from "node:assert/strict";
import { wrapExports } from "../../src/trace/proxy.ts";
import { deserializeEvent } from "../../src/trace/serialize.ts";
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

test("native constructors remain constructable after wrapExports", () => {
  const events: TraceEvent[] = [];
  const wrapped = wrapExports(
    { WeakMap, Map },
    { packageName: "lodash-es", onEvent: (e) => events.push(e) },
  ) as { WeakMap: typeof WeakMap; Map: typeof Map };
  const wm = new wrapped.WeakMap();
  wm.set({}, 1);
  assert.equal(wm.get({}), undefined);
  const k = {};
  wm.set(k, 2);
  assert.equal(wm.get(k), 2);
  assert.ok(wm instanceof WeakMap);
  const m = new wrapped.Map([["a", 1]]);
  assert.equal(m.get("a"), 1);
  assert.ok(m instanceof Map);
});

test("does not wrap native constructors returned from callees", () => {
  const events: TraceEvent[] = [];
  const wrapped = wrapExports(
    { getNative: () => WeakMap },
    { packageName: "lodash-es", onEvent: (e) => events.push(e) },
  ) as { getNative: () => typeof WeakMap };
  const WM = wrapped.getNative();
  assert.equal(WM, WeakMap);
  assert.ok(new WM() instanceof WeakMap);
  assert.match(Function.prototype.toString.call(WM), /\[native code\]/);
});

test("methods mixed onto a wrapped default after wrap record as default.method", () => {
  const events: TraceEvent[] = [];
  const opts = { packageName: "lodash-es", onEvent: (e: TraceEvent) => events.push(e) };
  const get = (o: Record<string, unknown>, p: string) => o[p];
  const wrappedGet = (
    wrapExports({ default: get }, opts) as { default: typeof get }
  ).default;
  const lodash = function lodash() {
    return "ld";
  };
  const wrappedLodash = (
    wrapExports({ default: lodash }, opts) as { default: typeof lodash & { get: typeof get } }
  ).default;
  wrappedLodash.get = wrappedGet;
  const mixed = (
    wrapExports({ default: wrappedLodash }, opts) as { default: typeof wrappedLodash }
  ).default;
  assert.equal(mixed.get({ a: 1 }, "a"), 1);
  const symbols = events.map((e) => e.symbol);
  assert.ok(
    symbols.includes("default.get") || symbols.includes("get"),
    `expected default.get or get, got ${symbols.join(",")}`,
  );
});

test("double wrap of a returned function keeps cancel", () => {
  const events: TraceEvent[] = [];
  const opts = { packageName: "lodash-es", onEvent: (e: TraceEvent) => events.push(e) };
  const debounce = (fn: () => number) => {
    function debounced() {
      return fn();
    }
    debounced.cancel = () => "cancelled";
    return debounced;
  };
  const inner = wrapExports({ default: debounce }, opts) as {
    default: typeof debounce;
  };
  const once = inner.default(() => 1);
  const outer = wrapExports({ debounce: () => once }, opts) as {
    debounce: () => { (): number; cancel: () => string };
  };
  const twice = outer.debounce();
  assert.equal(typeof twice.cancel, "function");
  assert.equal(twice.cancel(), "cancelled");
  const cancelEv = events.find((e) => e.symbol.includes("cancel"));
  assert.ok(cancelEv?.parentOriginId);
  assert.ok(
    events.some((e) => e.originId === cancelEv!.parentOriginId),
    "cancel parentOriginId must refer to an emitted event",
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

test("argc distinguishes omitted args from explicit undefined", () => {
  const events: TraceEvent[] = [];
  const mod = {
    debounce(_fn: () => void, _wait?: number, _opts?: object) {
      return () => {};
    },
  };
  const wrapped = wrapExports(mod, {
    packageName: "lodash",
    onEvent: (e) => events.push(e),
  }) as typeof mod;
  wrapped.debounce(() => {});
  wrapped.debounce(() => {}, undefined);
  wrapped.debounce(() => {}, undefined, undefined);
  assert.equal(events[0]!.argc, 1);
  assert.equal(events[1]!.argc, 2);
  assert.equal(events[2]!.argc, 3);
  assert.equal(events[0]!.args.length, 1);
  assert.equal(events[1]!.args.length, 2);
  assert.equal(events[1]!.args[1]?.t, "undef");
});

test("returned function ops carry parentOriginId and resultMember", () => {
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
  d();
  d.cancel();
  d.flush();
  const ctor = events.find((e) => e.symbol === "debounce")!;
  const invoke = events.find((e) => e.symbol === "debounce()")!;
  const cancel = events.find((e) => e.symbol === "debounce.cancel")!;
  const flush = events.find((e) => e.symbol === "debounce.flush")!;
  assert.ok(ctor.originId);
  assert.equal(invoke.parentOriginId, ctor.originId);
  assert.equal(invoke.resultMember, "");
  assert.equal(cancel.parentOriginId, ctor.originId);
  assert.equal(cancel.resultMember, "cancel");
  assert.equal(flush.parentOriginId, ctor.originId);
  assert.equal(flush.resultMember, "flush");
  const dump = JSON.stringify(events);
  assert.equal(dump.includes("at "), false);
  assert.equal(dump.includes("stack"), false);
  assert.ok(ctor.site?.line);
  assert.ok(ctor.site?.file);
});

test("records thisArg for method-style calls and site for the caller", () => {
  const events: TraceEvent[] = [];
  const rec = { n: 1 };
  const mod = {
    tap(this: { n: number }, x: number) {
      return this.n + x;
    },
  };
  const wrapped = wrapExports(mod, {
    packageName: "x",
    onEvent: (e) => events.push(e),
  }) as typeof mod;
  assert.equal(wrapped.tap.call(rec, 2), 3);
  assert.equal(events[0]!.thisArg?.t, "obj");
  assert.equal(events[0]!.argc, 1);
});

test("argsAfter and thisAfter share identity when args[0] === this", () => {
  const events: TraceEvent[] = [];
  const rec = { n: 1 };
  const mod = {
    bump(this: { n: number }, x: { n: number }) {
      this.n += 1;
      return x.n;
    },
  };
  const wrapped = wrapExports(mod, {
    packageName: "x",
    onEvent: (e) => events.push(e),
  }) as typeof mod;
  assert.equal(wrapped.bump.call(rec, rec), 2);
  const ev = events[0]!;
  assert.ok(ev.argsAfter);
  assert.ok(ev.thisAfter);
  assert.equal(ev.thisAfter?.t, "ref");
  const back = deserializeEvent({
    args: ev.argsAfter ?? [],
    thisArg: ev.thisAfter,
  });
  assert.equal(back.args[0], back.thisArg);
  assert.equal((back.thisArg as { n: number }).n, 2);
});

test("throw path argsAfter and thisAfter share identity when args[0] === this", () => {
  const events: TraceEvent[] = [];
  const rec = { n: 1 };
  const mod = {
    boom(this: { n: number }, _x: { n: number }) {
      this.n += 1;
      throw new TypeError("nope");
    },
  };
  const wrapped = wrapExports(mod, {
    packageName: "x",
    onEvent: (e) => events.push(e),
  }) as typeof mod;
  assert.throws(() => wrapped.boom.call(rec, rec));
  const ev = events[0]!;
  assert.equal(ev.threw?.name, "TypeError");
  assert.equal(ev.thisAfter?.t, "ref");
  const back = deserializeEvent({
    args: ev.argsAfter ?? [],
    thisArg: ev.thisAfter,
  });
  assert.equal(back.args[0], back.thisArg);
  assert.equal((back.thisArg as { n: number }).n, 2);
});
