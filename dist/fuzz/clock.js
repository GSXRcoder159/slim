import { setTimeout as unpatchedTimeout, clearTimeout as unpatchedClear } from "node:timers";
/** Wait for worker orig/slim load before any case timer starts. Independent of --budget-ms. */
export const STARTUP_MS = 2000;
/** Bound on Worker.terminate() during pool close / replace. */
export const SHUTDOWN_MS = 250;
/** Process-wall slack covering worker spawn. Alias of STARTUP_MS. Not a whole-run kill switch. */
export const BUDGET_SLACK_MS = STARTUP_MS;
/** Extra pickFuzzArgs cases after the required prefix. Not a wall-clock drain. */
export function extraCaseQuota(budgetMs) {
    if (!Number.isFinite(budgetMs))
        return 0;
    return Math.max(0, Math.floor(budgetMs));
}
/** Monotonic elapsed ms. Immune to the fake clock's Date.now patch. */
export function wallMs() {
    return Number(process.hrtime.bigint() / 1000000n);
}
export function nativeTimeout(fn, ms) {
    return unpatchedTimeout(fn, ms);
}
export function nativeClear(id) {
    unpatchedClear(id);
}
const MICROTASK_CAP = 1000;
const MAX_FIRES = 10_000;
export function createFakeClock(start = 0) {
    let time = start;
    let nextId = 1;
    const timers = new Map();
    let installed = false;
    const NativeDate = Date;
    const nativeNow = Date.now;
    const nativeSetTimeout = globalThis.setTimeout;
    const nativeSetInterval = globalThis.setInterval;
    const nativeClearTimeout = globalThis.clearTimeout;
    const nativeClearInterval = globalThis.clearInterval;
    const nativePerf = typeof globalThis.performance !== "undefined"
        ? globalThis.performance.now.bind(globalThis.performance)
        : () => 0;
    function fakeSetTimeout(fn, delay, ...args) {
        const id = nextId++;
        const wait = Math.max(0, Number(delay) || 0);
        timers.set(id, { id, due: time + wait, fn, args });
        return id;
    }
    function fakeSetInterval(fn, delay, ...args) {
        const id = nextId++;
        const wait = Math.max(0, Number(delay) || 0);
        timers.set(id, { id, due: time + wait, fn, args, interval: wait });
        return id;
    }
    function fakeClear(id) {
        if (typeof id === "number")
            timers.delete(id);
    }
    class FakeDate extends NativeDate {
        constructor(...args) {
            if (args.length === 0)
                super(time);
            else
                super(...args);
        }
        static now() {
            return time;
        }
        static parse = NativeDate.parse;
        static UTC = NativeDate.UTC;
    }
    async function flushMicrotasks(cap = MICROTASK_CAP) {
        const n = Math.min(cap, MICROTASK_CAP);
        for (let i = 0; i < n; i++)
            await Promise.resolve();
    }
    function nextDue(target) {
        let best;
        for (const t of timers.values()) {
            if (t.due > target)
                continue;
            if (!best ||
                t.due < best.due ||
                (t.due === best.due && t.id < best.id)) {
                best = t;
            }
        }
        return best;
    }
    const clock = {
        now() {
            return time;
        },
        getTime() {
            return time;
        },
        set(ms) {
            time = ms;
        },
        isInstalled() {
            return installed;
        },
        reset(ms = 0) {
            timers.clear();
            time = ms;
        },
        install() {
            if (installed)
                return;
            globalThis.setTimeout = fakeSetTimeout;
            globalThis.setInterval = fakeSetInterval;
            globalThis.clearTimeout = fakeClear;
            globalThis.clearInterval = fakeClear;
            // ponytail: lodash caches root.Date at load; patch NativeDate.now in place.
            NativeDate.now = () => time;
            globalThis.Date = FakeDate;
            if (typeof globalThis.performance !== "undefined") {
                globalThis.performance.now = () => time - start;
            }
            installed = true;
        },
        uninstall() {
            if (!installed)
                return;
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
        async advance(ms) {
            const target = time + ms;
            if (ms <= 0) {
                if (ms < 0)
                    time = target;
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
                if (t.interval !== undefined)
                    t.due = time + t.interval;
                else
                    timers.delete(t.id);
                try {
                    t.fn(...t.args);
                }
                catch (err) {
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
//# sourceMappingURL=clock.js.map