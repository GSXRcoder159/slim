import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeClock } from "../../src/fuzz/clock.ts";
import {
  runDebounceScript,
  TAXONOMY,
  taxonomyForObserved,
} from "../../src/fuzz/debounce-driver.ts";

/** Tiny trailing-only debounce used to prove the driver, independent of catalog. */
function trailingDebounce(
  fn: (...args: unknown[]) => unknown,
  wait: number,
): {
  (...args: unknown[]): unknown;
  cancel(): void;
  flush(): unknown;
} {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: unknown[] = [];
  let lastThis: unknown;
  let result: unknown;
  function invoke() {
    timer = null;
    result = fn.apply(lastThis, lastArgs);
    return result;
  }
  function debounced(this: unknown, ...args: unknown[]) {
    lastArgs = args;
    lastThis = this;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(invoke, wait);
    return result;
  }
  debounced.cancel = function cancel() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  debounced.flush = function flush() {
    if (timer !== null) {
      clearTimeout(timer);
      return invoke();
    }
    return result;
  };
  return debounced;
}

test("CI full taxonomy includes leading-only for argc=2 envelopes", () => {
  const user = taxonomyForObserved({ exportName: "debounce", observedArgc: [2] });
  assert.equal(
    user.some((s) => s === TAXONOMY["leading-only"]),
    false,
    "user envelopes without options must not include leading-only",
  );
  const ci = taxonomyForObserved({
    exportName: "debounce",
    observedArgc: [2],
    full: true,
  });
  assert.ok(
    ci.some((s) => s === TAXONOMY["leading-only"]),
    "CI taxonomy must include leading-only even for argc=2",
  );
  assert.equal(ci.length, 14);
});

test("TAXONOMY exports Slim CI scripts", () => {
  const names = [
    "trailing-single",
    "trailing-burst",
    "leading-only",
    "leading-trailing-one",
    "leading-trailing-two",
    "maxWait-stream",
    "cancel-mid",
    "flush-mid",
    "flush-empty",
    "wait-zero",
    "this-and-args",
    "return-last",
    "func-throws",
    "time-rewind",
  ];
  for (const n of names) {
    assert.ok(TAXONOMY[n], `missing taxonomy script ${n}`);
    assert.ok(Array.isArray(TAXONOMY[n]!.events));
  }
});

test("trailing-single fires once after wait", async () => {
  const clock = createFakeClock(0);
  const out = await runDebounceScript(
    trailingDebounce,
    TAXONOMY["trailing-single"]!,
    clock,
  );
  assert.equal(out.spies.length, 1);
  assert.deepEqual(out.spies[0]!.args, ["a"]);
});

test("trailing-burst uses last args", async () => {
  const clock = createFakeClock(0);
  const out = await runDebounceScript(
    trailingDebounce,
    TAXONOMY["trailing-burst"]!,
    clock,
  );
  assert.equal(out.spies.length, 1);
  assert.deepEqual(out.spies[0]!.args, ["last"]);
});

test("cancel-mid prevents the trailing call", async () => {
  const clock = createFakeClock(0);
  const out = await runDebounceScript(
    trailingDebounce,
    TAXONOMY["cancel-mid"]!,
    clock,
  );
  assert.equal(out.spies.length, 0);
});

test("flush-mid invokes immediately", async () => {
  const clock = createFakeClock(0);
  const out = await runDebounceScript(
    trailingDebounce,
    TAXONOMY["flush-mid"]!,
    clock,
  );
  assert.equal(out.spies.length, 1);
  assert.deepEqual(out.spies[0]!.args, ["flush-me"]);
  assert.equal(out.flushResults.length, 1);
});

test("this-and-args preserves this and arguments", async () => {
  const clock = createFakeClock(0);
  const out = await runDebounceScript(
    trailingDebounce,
    TAXONOMY["this-and-args"]!,
    clock,
  );
  assert.equal(out.spies.length, 1);
  assert.deepEqual(out.spies[0]!.thisArg, { id: 7 });
  assert.deepEqual(out.spies[0]!.args, ["x", 2]);
});
