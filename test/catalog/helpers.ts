/**
 * Shared helpers for catalog vs lodash oracle tests.
 */

import assert from "node:assert/strict";
import lodash from "lodash";

export { lodash };

export function same(
  label: string,
  slimFn: (...args: never[]) => unknown,
  lodashFn: (...args: never[]) => unknown,
  args: unknown[],
): void {
  const actual = slimFn(...(args as never[]));
  const expected = lodashFn(...(args as never[]));
  assert.deepEqual(actual, expected, label);
}

export class FakeClock {
  nowMs = 0;
  private timers = new Map<number, { cb: () => void; when: number }>();
  private nextId = 1;
  private savedNow!: typeof Date.now;
  private savedSet!: typeof setTimeout;
  private savedClear!: typeof clearTimeout;

  install(): void {
    this.nowMs = 0;
    this.timers.clear();
    this.nextId = 1;
    this.savedNow = Date.now;
    this.savedSet = setTimeout;
    this.savedClear = clearTimeout;
    Date.now = () => this.nowMs;
    globalThis.setTimeout = ((cb: () => void, ms?: number) => {
      const id = this.nextId++;
      this.timers.set(id, { cb, when: this.nowMs + Number(ms) });
      return id as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
      this.timers.delete(id as unknown as number);
    }) as typeof clearTimeout;
  }

  restore(): void {
    Date.now = this.savedNow;
    globalThis.setTimeout = this.savedSet;
    globalThis.clearTimeout = this.savedClear;
    this.timers.clear();
  }

  tick(ms: number): void {
    this.nowMs += ms;
    this.flushDue();
  }

  private flushDue(): void {
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const [id, timer] of [...this.timers]) {
        if (timer.when <= this.nowMs) {
          this.timers.delete(id);
          timer.cb();
          progressed = true;
        }
      }
    }
  }
}
