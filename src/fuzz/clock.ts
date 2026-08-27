import { setTimeout as unpatchedTimeout, clearTimeout as unpatchedClear } from "node:timers";

/** Wait for worker orig/slim load before any case timer starts. Independent of --budget-ms. */
export const STARTUP_MS = 2000;

/** Bound on Worker.terminate() during pool close / replace. */
export const SHUTDOWN_MS = 250;

/** Process-wall slack covering worker spawn. Alias of STARTUP_MS; documented bound is budgetMs + STARTUP_MS + SHUTDOWN_MS. */
export const BUDGET_SLACK_MS = STARTUP_MS;

/** Extra pickFuzzArgs cases after the required prefix. Not a wall-clock drain. */
export function extraCaseQuota(budgetMs: number): number {
  if (!Number.isFinite(budgetMs)) return 0;
  return Math.max(0, Math.floor(budgetMs));
}

/** Monotonic elapsed ms. Immune to the fake clock's Date.now patch. */
export function wallMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

export function nativeTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
  return unpatchedTimeout(fn, ms);
}

export function nativeClear(id: ReturnType<typeof setTimeout>): void {
  unpatchedClear(id);
}

interface Timer {
  id: number;
  due: number;
  fn: (...args: unknown[]) => unknown;
  args: unknown[];
  interval?: number;
}

export interface FakeClock {
  now(): number;
  install(): void;
  uninstall(): void;
  isInstalled(): boolean;
  reset(ms?: number): void;
  advance(ms: number): Promise<void>;
  set(ms: number): void;
  getTime(): number;
}

const MICROTASK_CAP = 1000;
const MAX_FIRES = 10_000;

export function createFakeClock(start = 0): FakeClock {
  let time = start;
  let nextId = 1;
  const timers = new Map<number, Timer>();
  let installed = false;

  const NativeDate = Date;
  const nativeNow = Date.now;
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeSetInterval = globalThis.setInterval;
  const nativeClearTimeout = globalThis.clearTimeout;
  const nativeClearInterval = globalThis.clearInterval;
  const nativePerf =
    typeof globalThis.performance !== "undefined"
      ? globalThis.performance.now.bind(globalThis.performance)
      : () => 0;

  function fakeSetTimeout(
    fn: (...args: unknown[]) => unknown,
    delay?: number,
    ...args: unknown[]
  ): number {
    const id = nextId++;
    const wait = Math.max(0, Number(delay) || 0);
    timers.set(id, { id, due: time + wait, fn, args });
    return id;
  }

  function fakeSetInterval(
    fn: (...args: unknown[]) => unknown,
    delay?: number,
    ...args: unknown[]
  ): number {
    const id = nextId++;
    const wait = Math.max(0, Number(delay) || 0);
    timers.set(id, { id, due: time + wait, fn, args, interval: wait });
    return id;
  }

  function fakeClear(id: number | { [k: string]: unknown } | undefined): void {
    if (typeof id === "number") timers.delete(id);
  }

  class FakeDate extends NativeDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(time);
      else super(...(args as [string | number | Date]));
    }
    static now(): number {
      return time;
    }
    static parse = NativeDate.parse;
    static UTC = NativeDate.UTC;
  }

  async function flushMicrotasks(cap = MICROTASK_CAP): Promise<void> {
    const n = Math.min(cap, MICROTASK_CAP);
    for (let i = 0; i < n; i++) await Promise.resolve();
  }

  function nextDue(target: number): Timer | undefined {
    let best: Timer | undefined;
    for (const t of timers.values()) {
      if (t.due > target) continue;
      if (
        !best ||
        t.due < best.due ||
        (t.due === best.due && t.id < best.id)
      ) {
        best = t;
      }
    }
    return best;
  }

  const clock: FakeClock = {
    now(): number {
      return time;
    },
    getTime(): number {
      return time;
    },
    set(ms: number): void {
      time = ms;
    },
    isInstalled(): boolean {
      return installed;
    },
    reset(ms = 0): void {
      timers.clear();
      time = ms;
    },
    install(): void {
      if (installed) return;
      globalThis.setTimeout = fakeSetTimeout as unknown as typeof setTimeout;
      globalThis.setInterval = fakeSetInterval as unknown as typeof setInterval;
      globalThis.clearTimeout = fakeClear as unknown as typeof clearTimeout;
      globalThis.clearInterval = fakeClear as unknown as typeof clearInterval;
      // ponytail: lodash caches root.Date at load; patch NativeDate.now in place.
      NativeDate.now = () => time;
      globalThis.Date = FakeDate as unknown as DateConstructor;
      if (typeof globalThis.performance !== "undefined") {
        globalThis.performance.now = () => time - start;
      }
      installed = true;
    },
    uninstall(): void {
      if (!installed) return;
      globalThis.setTimeout = nativeSetTimeout;
      globalThis.setInterval = nativeSetInterval;
      globalThis.clearTimeout = nativeClearTimeout;
      globalThis.clearInterval = nativeClearInterval;
      NativeDate.now = nativeNow;
      globalThis.Date = NativeDate;
      if (typeof globalThis.performance !== "undefined") {
        globalThis.performance.now = nativePerf;
      }
      installed = false;
    },
    async advance(ms: number): Promise<void> {
      const target = time + ms;
      if (ms <= 0) {
        if (ms < 0) time = target;
        await flushMicrotasks();
        return;
      }
      let fires = 0;
      while (fires < MAX_FIRES) {
        const t = nextDue(target);
        if (!t) {
          time = target;
          break;
        }
        time = t.due;
        if (t.interval !== undefined) t.due = time + t.interval;
        else timers.delete(t.id);
        try {
          t.fn(...t.args);
        } catch (err) {
          await flushMicrotasks();
          throw err;
        }
        fires++;
        await flushMicrotasks();
      }
      time = target;
      await flushMicrotasks();
    },
  };

  return clock;
}
