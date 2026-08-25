process.env.CI = "1";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import lodash from "lodash";
import { LODASH_SYMBOLS, getCatalog } from "../../src/generate/catalog/index.ts";
import { debounce } from "../../src/generate/catalog/lodash.debounce.ts";
import { throttle } from "../../src/generate/catalog/lodash.throttle.ts";
import { TAXONOMY, runDebounceScript, type DebounceScript } from "../../src/fuzz/debounce-driver.ts";
import { createFakeClock } from "../../src/fuzz/clock.ts";

describe("lodash catalog oracle qualification", () => {
  it("every registered lodash symbol has a live impl that matches lodash on smoke cases", () => {
    const missing: string[] = [];
    for (const symbol of LODASH_SYMBOLS) {
      const impl = getCatalog("lodash", symbol)?.impl;
      if (typeof impl !== "function") {
        missing.push(symbol);
        continue;
      }
      const orig = (lodash as unknown as Record<string, Function>)[symbol];
      assert.equal(typeof orig, "function", `lodash.${symbol} missing on oracle`);
    }
    assert.deepEqual(missing, []);

    const get = getCatalog("lodash", "get")!.impl as Function;
    assert.equal(get({ a: { b: 1 } }, "a.b"), lodash.get({ a: { b: 1 } }, "a.b"));
    const groupBy = getCatalog("lodash", "groupBy")!.impl as Function;
    assert.deepEqual(groupBy([6.1, 4.2, 6.3], Math.floor), lodash.groupBy([6.1, 4.2, 6.3], Math.floor));
    const pick = getCatalog("lodash", "pick")!.impl as Function;
    assert.deepEqual(pick({ a: 1, b: 2 }, ["a"]), lodash.pick({ a: 1, b: 2 }, ["a"]));
    const isEqual = getCatalog("lodash", "isEqual")!.impl as Function;
    assert.equal(isEqual({ a: 1 }, { a: 1 }), lodash.isEqual({ a: 1 }, { a: 1 }));
    const first = getCatalog("lodash", "first")!.impl as Function;
    assert.equal(first([1, 2]), lodash.first([1, 2]));
  });

  it("debounce matches lodash on the full timer taxonomy", async () => {
    for (const [name, script] of Object.entries(TAXONOMY)) {
      const slimClock = createFakeClock(0);
      const origClock = createFakeClock(0);
      const slim = await runDebounceScript(debounce, script, slimClock);
      const orig = await runDebounceScript(lodash.debounce, script, origClock);
      assert.deepEqual(slim.spies, orig.spies, `debounce ${name} spies`);
      assert.deepEqual(slim.returns, orig.returns, `debounce ${name} returns`);
      assert.deepEqual(slim.flushResults, orig.flushResults, `debounce ${name} flush`);
    }
  });

  it("throttle matches lodash on the timer taxonomy (leading/trailing only)", async () => {
    for (const [name, script] of Object.entries(TAXONOMY)) {
      const throttleScript: DebounceScript = {
        ...script,
        options: script.options
          ? { leading: script.options.leading, trailing: script.options.trailing }
          : undefined,
      };
      const slimClock = createFakeClock(0);
      const origClock = createFakeClock(0);
      const slim = await runDebounceScript(throttle, throttleScript, slimClock);
      const orig = await runDebounceScript(lodash.throttle, throttleScript, origClock);
      assert.deepEqual(slim.spies, orig.spies, `throttle ${name} spies`);
      assert.deepEqual(slim.returns, orig.returns, `throttle ${name} returns`);
      assert.deepEqual(slim.flushResults, orig.flushResults, `throttle ${name} flush`);
    }
  });
});
