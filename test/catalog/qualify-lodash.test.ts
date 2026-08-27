process.env.CI = "1";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import lodash from "lodash";
import { debounce } from "../../src/generate/catalog/lodash.debounce.ts";
import { throttle } from "../../src/generate/catalog/lodash.throttle.ts";
import { TAXONOMY, runDebounceScript, type DebounceScript } from "../../src/fuzz/debounce-driver.ts";
import { createFakeClock } from "../../src/fuzz/clock.ts";

describe("lodash catalog timer taxonomy", () => {
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
