import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import lodash from "lodash";
import { debounce } from "../../src/generate/catalog/lodash.debounce.ts";
import { throttle } from "../../src/generate/catalog/lodash.throttle.ts";
import { once } from "../../src/generate/catalog/lodash.once.ts";
import { FakeClock } from "./helpers.ts";

describe("lodash.debounce / throttle / once throws", () => {
  it("throws TypeError('Expected a function') like lodash", () => {
    for (const [name, slimFn, lodashFn] of [
      ["debounce", debounce, lodash.debounce],
      ["throttle", throttle, lodash.throttle],
      ["once", once, lodash.once],
    ] as const) {
      assert.throws(() => slimFn(null as never), { name: "TypeError", message: "Expected a function" }, name);
      assert.throws(() => lodashFn(null as never), { name: "TypeError", message: "Expected a function" }, name);
    }
  });
});

describe("lodash.once", () => {
  it("invokes once and then returns the first result", () => {
    let n = 0;
    const f = once((x: number) => {
      n += 1;
      return x + 1;
    });
    assert.equal(f(1), 2);
    assert.equal(f(9), 2);
    assert.equal(n, 1);
    assert.equal(once(lodash.identity)(3), lodash.once(lodash.identity)(3));
  });

  it("forwards this", () => {
    const o = {
      x: 1,
      f: once(function (this: { x: number }) {
        return this.x;
      }),
    };
    assert.equal(o.f(), 1);
  });
});

describe("lodash.debounce", () => {
  const clock = new FakeClock();
  afterEach(() => clock.restore());

  it("trailing-only fires last args after wait", () => {
    clock.install();
    const calls: unknown[][] = [];
    const d = debounce(function (this: unknown, ...args: unknown[]) {
      calls.push(args);
    }, 100);
    d(1);
    d(2);
    clock.tick(99);
    assert.deepEqual(calls, []);
    clock.tick(1);
    assert.deepEqual(calls, [[2]]);
  });

  it("leading && trailing: trailing only if invoked more than once", () => {
    clock.install();
    const times: number[] = [];
    const d = debounce(() => times.push(clock.nowMs), 100, { leading: true, trailing: true });
    d();
    assert.deepEqual(times, [0]);
    clock.tick(100);
    assert.deepEqual(times, [0]);
  });

  it("leading && trailing: second call in the window schedules trailing", () => {
    clock.install();
    const times: number[] = [];
    const d = debounce(() => times.push(clock.nowMs), 100, { leading: true, trailing: true });
    d();
    clock.tick(50);
    d();
    clock.tick(100);
    assert.deepEqual(times, [0, 150]);
  });

  it("leading true trailing false fires immediately and not after wait", () => {
    clock.install();
    let n = 0;
    const d = debounce(() => {
      n += 1;
    }, 100, { leading: true, trailing: false });
    d();
    d();
    clock.tick(100);
    assert.equal(n, 1);
  });

  it("wait === 0 && !leading uses setTimeout(0)", () => {
    clock.install();
    let n = 0;
    const d = debounce(() => {
      n += 1;
    }, 0);
    d();
    assert.equal(n, 0);
    clock.tick(0);
    assert.equal(n, 1);
  });

  it("Number(wait) || 0 and cancel / flush", () => {
    clock.install();
    let n = 0;
    const d = debounce(() => {
      n += 1;
      return n;
    }, "100" as unknown as number);
    d();
    d.cancel();
    clock.tick(100);
    assert.equal(n, 0);

    d();
    assert.equal(d.flush(), 1);
    assert.equal(n, 1);
    assert.equal(d.flush(), 1);
  });

  it("maxWait fires while calls keep coming", () => {
    clock.install();
    const times: number[] = [];
    const d = debounce(() => times.push(clock.nowMs), 100, { maxWait: 150 });
    d();
    clock.tick(40);
    d();
    clock.tick(40);
    d();
    clock.tick(40);
    d();
    clock.tick(40);
    assert.ok(times.length >= 1);
    assert.ok(times[0]! <= 160);
  });

  it("time going backwards should invoke", () => {
    clock.install();
    let n = 0;
    const d = debounce(() => {
      n += 1;
    }, 100, { leading: true, trailing: false });
    d();
    assert.equal(n, 1);
    clock.tick(100);
    clock.nowMs = -10;
    d();
    assert.equal(n, 2);
  });

  it("preserves last this", () => {
    clock.install();
    const seen: unknown[] = [];
    const d = debounce(function (this: unknown) {
      seen.push(this);
    }, 10);
    const ctx = { id: 1 };
    d.call(ctx);
    clock.tick(10);
    assert.equal(seen[0], ctx);
  });
});

describe("lodash.throttle", () => {
  const clock = new FakeClock();
  afterEach(() => clock.restore());

  it("leading call invokes immediately (lodash.throttle defaults)", () => {
    clock.install();
    let n = 0;
    const t = throttle(() => {
      n += 1;
    }, 100);
    t();
    assert.equal(n, 1);
    t();
    assert.equal(n, 1);
    clock.tick(100);
    assert.equal(n, 2);
  });

  it("trailing: false suppresses the trailing call", () => {
    clock.install();
    let n = 0;
    const t = throttle(() => {
      n += 1;
    }, 100, { trailing: false });
    t();
    t();
    clock.tick(100);
    assert.equal(n, 1);
  });
});
