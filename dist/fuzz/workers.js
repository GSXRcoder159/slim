var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { siblingModule } from "../runtime-path.js";
import { EXIT_ENV, EXIT_FAIL, SlimExit } from "../exit.js";
import { invoke, equalResults, equal, settleOutcome } from "./equal.js";
import { setTimeout as timeoutFn, clearTimeout as clearTimeoutFn, setImmediate as nextTurn, } from "node:timers";
import { createFakeClock, STARTUP_MS, SHUTDOWN_MS, wallMs } from "./clock.js";
import { withSeededCrypto } from "./crypto.js";
import { minimize } from "./minimize.js";
import { runDebounceScript, } from "./debounce-driver.js";
import { deserializeEvent, serializeEvent, snapshot } from "../trace/serialize.js";
import { canonicalLodashSymbol } from "../generate/catalog/lodash-names.js";
const MINIMIZE_MS = 2000;
/** Per-case stall timeout after worker ready. Independent of --budget-ms extra-case quota. */
export const JOB_TIMEOUT_CAP_MS = 5000;
export function createPool(opts) {
    if (opts.workers > 1)
        return createThreadPool(opts);
    return createInProcessPool(opts);
}
/** Resolve worker-thread next to this module. Prefers `.js` (pack) then `.ts` (source). */
export function workerThreadUrl(metaUrl = import.meta.url) {
    return pathToFileURL(siblingModule(metaUrl, "worker-thread"));
}
/** Bust ESM cache of the slim module for this generate attempt. */
export function withSlimQuery(spec, hash) {
    const href = spec.startsWith("file:") ? spec : pathToFileURL(spec).href;
    if (!hash)
        return href;
    const url = new URL(href);
    url.searchParams.set("slim", hash);
    return url.href;
}
function workerEnv() {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    return env;
}
const WORKER_EXEC_FLAG = /^(?:--experimental-strip-types|--experimental-require-module|--import|--require)(?:=|$)/;
/** Node 24 runners inject V8/TLS flags that `new Worker` rejects (ERR_WORKER_INVALID_EXEC_ARGV). */
export function workerExecArgv(argv = process.execArgv) {
    const out = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--test" || a.startsWith("--test-"))
            continue;
        if (!WORKER_EXEC_FLAG.test(a))
            continue;
        out.push(a);
        if (!a.includes("=") && (a === "--import" || a === "--require")) {
            const next = argv[i + 1];
            if (next && !next.startsWith("-")) {
                out.push(next);
                i += 1;
            }
        }
    }
    return out;
}
export function defaultJobTimeoutMs() {
    return JOB_TIMEOUT_CAP_MS;
}
function terminateSoon(w, ms = SHUTDOWN_MS) {
    try {
        w.unref();
    }
    catch {
        /* already gone */
    }
    return new Promise((resolve) => {
        let done = false;
        const finish = () => {
            if (done)
                return;
            done = true;
            try {
                w.unref();
            }
            catch {
                /* gone */
            }
            resolve();
        };
        w.once("exit", finish);
        timeoutFn(finish, ms);
        Promise.resolve(w.terminate()).then(() => undefined, finish);
    });
}
function raceTimeout(promise, ms, err) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            timer = timeoutFn(() => reject(err), Math.max(1, ms));
        }),
    ]).finally(() => {
        if (timer)
            clearTimeoutFn(timer);
    });
}
function createThreadPool(opts) {
    const n = Math.max(1, opts.workers);
    const defaultTimeout = opts.timeoutMs ?? JOB_TIMEOUT_CAP_MS;
    const workers = [];
    const idle = [];
    const retiring = [];
    const waiters = [];
    let closed = false;
    let nextId = 1;
    const startedAt = wallMs();
    const pending = new Map();
    const inflight = new Map();
    const readyAt = new WeakMap();
    const spawnedAt = new WeakMap();
    const retired = new WeakSet();
    const becameReady = new WeakSet();
    const slimModule = withSlimQuery(opts.slimModule, opts.slimHash);
    function failJob(id, err) {
        const waiter = pending.get(id);
        if (!waiter)
            return;
        pending.delete(id);
        inflight.delete(waiter.worker);
        waiter.reject(err);
    }
    function succeedJob(id, result) {
        const waiter = pending.get(id);
        if (!waiter)
            return;
        pending.delete(id);
        inflight.delete(waiter.worker);
        waiter.resolve(result);
    }
    function spawn() {
        let settleReady;
        let failReady;
        let settled = false;
        const ready = new Promise((resolve, reject) => {
            settleReady = () => {
                if (settled)
                    return;
                settled = true;
                resolve();
            };
            failReady = (e) => {
                if (settled)
                    return;
                settled = true;
                reject(e);
            };
        });
        const w = new Worker(workerThreadUrl(), {
            execArgv: workerExecArgv(),
            env: workerEnv(),
            workerData: {
                origModule: opts.origModule,
                slimModule,
                symbols: opts.symbols,
                clock: opts.clock === true,
                projectRoot: opts.projectRoot,
            },
        });
        readyAt.set(w, ready);
        spawnedAt.set(w, wallMs());
        w.on("message", (msg) => {
            if (msg.type === "ready") {
                becameReady.add(w);
                settleReady();
                return;
            }
            if (closed || !workers.includes(w))
                return;
            if (msg.type === "error" && msg.id === undefined) {
                failReady(new SlimExit(EXIT_ENV, `fuzz worker crashed: ${msg.error ?? "worker error"}`));
                return;
            }
            if (msg.type === "result" && msg.id !== undefined && msg.result) {
                succeedJob(msg.id, fromCloneableResult(msg.result));
            }
            else if (msg.type === "error" && msg.id !== undefined) {
                const text = msg.error ?? "worker error";
                failJob(msg.id, /malformed/i.test(text) ? new SlimExit(EXIT_ENV, text) : new Error(text));
            }
            else if (msg.id !== undefined) {
                failJob(msg.id, new SlimExit(EXIT_ENV, "malformed worker message"));
            }
        });
        w.on("error", (err) => {
            const crash = new SlimExit(EXIT_ENV, `fuzz worker crashed: ${err.message}`);
            failReady(crash);
            const id = inflight.get(w);
            if (id !== undefined)
                failJob(id, crash);
            else if (!closed && becameReady.has(w)) {
                const fresh = replaceWorker(w);
                if (fresh)
                    release(fresh);
            }
        });
        w.on("exit", (code) => {
            if (closed)
                return;
            const crash = new SlimExit(EXIT_ENV, `fuzz worker crashed (exit ${code ?? 1})`);
            failReady(crash);
            const id = inflight.get(w);
            if (id !== undefined)
                failJob(id, crash);
            else if (becameReady.has(w)) {
                const fresh = replaceWorker(w);
                if (fresh)
                    release(fresh);
            }
        });
        return w;
    }
    function retire(dead) {
        if (retired.has(dead))
            return;
        retired.add(dead);
        inflight.delete(dead);
        const idleAt = idle.indexOf(dead);
        if (idleAt >= 0)
            idle.splice(idleAt, 1);
        const wi = workers.indexOf(dead);
        if (wi >= 0)
            workers.splice(wi, 1);
        retiring.push(dead);
        // Never terminate() on this turn: killing a tight-loop isolate can stall
        // the event loop and prevent sibling job timers from firing.
        nextTurn(() => {
            void terminateSoon(dead);
        });
    }
    function replaceWorker(dead) {
        if (retired.has(dead)) {
            retire(dead);
            return undefined;
        }
        retire(dead);
        if (closed)
            return undefined;
        const w = spawn();
        workers.push(w);
        return w;
    }
    for (let i = 0; i < n; i++) {
        const w = spawn();
        workers.push(w);
        idle.push(w);
    }
    async function waitReady(w) {
        const p = readyAt.get(w);
        if (!p)
            throw new SlimExit(EXIT_ENV, "insufficient startup budget");
        const from = spawnedAt.get(w) ?? startedAt;
        const left = Math.max(1, STARTUP_MS - (wallMs() - from));
        await raceTimeout(p, left, new SlimExit(EXIT_ENV, "insufficient startup budget"));
    }
    async function acquire() {
        if (closed)
            throw new SlimExit(EXIT_ENV, "fuzz worker pool closed");
        const w = idle.pop() ?? (await new Promise((resolve, reject) => waiters.push({ resolve, reject })));
        try {
            await waitReady(w);
            return w;
        }
        catch (e) {
            if (!closed) {
                const fresh = replaceWorker(w);
                if (fresh)
                    release(fresh);
            }
            throw e;
        }
    }
    function release(w) {
        if (closed || !workers.includes(w))
            return;
        const waiter = waiters.shift();
        if (waiter)
            waiter.resolve(w);
        else
            idle.push(w);
    }
    return {
        async ready() {
            if (closed)
                throw new SlimExit(EXIT_ENV, "fuzz worker pool closed");
            const left = Math.max(1, STARTUP_MS - (wallMs() - startedAt));
            await raceTimeout(Promise.all(workers.map((w) => waitReady(w))), left, new SlimExit(EXIT_ENV, "insufficient startup budget"));
        },
        async runCase(job, timeoutMs = defaultTimeout) {
            if (closed)
                throw new SlimExit(EXIT_ENV, "fuzz worker pool closed");
            const acquired = await acquire();
            const id = nextId++;
            let replaced = false;
            let timer;
            try {
                let cloneable;
                try {
                    cloneable = toCloneableJob(job);
                }
                catch (e) {
                    throw new SlimExit(EXIT_FAIL, `serialization failure: ${e instanceof Error ? e.message : String(e)}`);
                }
                return await new Promise((resolve, reject) => {
                    pending.set(id, { resolve, reject, worker: acquired });
                    inflight.set(acquired, id);
                    timer = timeoutFn(() => {
                        failJob(id, new SlimExit(EXIT_ENV, "fuzz worker timeout"));
                    }, Math.max(1, timeoutMs));
                    try {
                        acquired.postMessage({ type: "run", id, job: cloneable });
                    }
                    catch (e) {
                        failJob(id, new SlimExit(EXIT_FAIL, `serialization failure: ${e instanceof Error ? e.message : String(e)}`));
                    }
                });
            }
            catch (e) {
                if (e instanceof SlimExit && e.code === EXIT_ENV && !closed) {
                    replaced = true;
                    const fresh = replaceWorker(acquired);
                    if (fresh)
                        release(fresh);
                }
                throw e;
            }
            finally {
                if (timer)
                    clearTimeoutFn(timer);
                inflight.delete(acquired);
                pending.delete(id);
                if (!replaced)
                    release(acquired);
            }
        },
        async close() {
            if (closed)
                return;
            closed = true;
            for (const [, p] of pending) {
                p.reject(new SlimExit(EXIT_ENV, "fuzz worker pool closed"));
            }
            pending.clear();
            inflight.clear();
            for (const waiter of waiters) {
                waiter.reject(new SlimExit(EXIT_ENV, "fuzz worker pool closed"));
            }
            waiters.length = 0;
            const dying = [...new Set([...workers, ...retiring])];
            workers.length = 0;
            retiring.length = 0;
            idle.length = 0;
            await Promise.all(dying.map((w) => terminateSoon(w)));
        },
    };
}
function createInProcessPool(opts) {
    let orig = null;
    let slim = null;
    let persistClock;
    let loading = null;
    async function ensure() {
        if (orig && slim)
            return;
        if (!loading) {
            loading = (async () => {
                if (opts.clock) {
                    persistClock = createFakeClock(0);
                    persistClock.install();
                }
                orig = await loadOrig(opts.origModule, opts.projectRoot);
                slim = await loadSlim(withSlimQuery(opts.slimModule, opts.slimHash));
            })();
        }
        await loading;
    }
    return {
        async ready() {
            await ensure();
        },
        async runCase(job) {
            await ensure();
            return runJob(orig, slim, job, persistClock);
        },
        async close() {
            persistClock?.uninstall();
            persistClock = undefined;
            orig = null;
            slim = null;
        },
    };
}
function moduleHref(spec) {
    if (/^(?:file|data|node):/i.test(spec))
        return spec;
    return pathToFileURL(spec).href;
}
export async function loadOrig(spec, projectRoot = process.cwd()) {
    const req = createRequire(join(projectRoot, "package.json"));
    try {
        return aliasLodashPerMethod(unwrapModule(req(spec)), spec);
    }
    catch {
        const m = await import(__rewriteRelativeImportExtension(moduleHref(spec)));
        return aliasLodashPerMethod(unwrapModule(m), spec);
    }
}
export async function loadSlim(spec) {
    const m = await import(__rewriteRelativeImportExtension(moduleHref(spec)));
    return unwrapModule(m);
}
function unwrapModule(m) {
    if (m == null)
        return {};
    const out = {};
    if (typeof m === "function") {
        out.default = m;
        aliasFnName(out, m);
        Object.assign(out, pickFns(m));
    }
    if (typeof m === "object" || typeof m === "function") {
        const rec = m;
        Object.assign(out, pickFns(rec));
        const def = rec.default;
        if (typeof def === "function") {
            out.default = def;
            aliasFnName(out, def);
            Object.assign(out, pickFns(def));
        }
        else if (def && typeof def === "object") {
            Object.assign(out, pickFns(def));
        }
    }
    return out;
}
function aliasFnName(out, fn) {
    const n = fn.name;
    if (n && n !== "default" && /^[A-Za-z_$][\w$]*$/.test(n) && typeof out[n] !== "function") {
        out[n] = fn;
    }
}
/** Per-method lodash packages often export an anonymous CJS function (`lodash.pick`). */
function aliasLodashPerMethod(out, spec) {
    const base = spec.replace(/\\/g, "/").split("/").pop() ?? spec;
    if (!base.startsWith("lodash."))
        return out;
    const forced = canonicalLodashSymbol(base.slice("lodash.".length));
    if (!forced)
        return out;
    const fn = typeof out.default === "function" ? out.default : undefined;
    if (typeof fn !== "function")
        return out;
    if (typeof out[forced] !== "function")
        out[forced] = fn;
    return out;
}
function pickFns(rec) {
    const out = {};
    for (const k of Object.getOwnPropertyNames(rec)) {
        let v;
        try {
            v = rec[k];
        }
        catch {
            continue;
        }
        if (typeof v === "function")
            out[k] = v;
    }
    return out;
}
export function toCloneableJob(job) {
    const ev = serializeEvent({ args: job.args, thisArg: job.thisArg });
    return {
        ...job,
        args: ev.args,
        thisArg: ev.thisArg,
    };
}
export function fromCloneableJob(job) {
    const ev = deserializeEvent({
        args: job.args,
        thisArg: job.thisArg === undefined ? undefined : job.thisArg,
    });
    return {
        ...job,
        args: ev.args,
        thisArg: ev.thisArg,
    };
}
export function toCloneableResult(result) {
    return {
        symbol: result.symbol,
        ok: result.ok,
        reason: result.reason,
        args: result.args === undefined ? undefined : snapshot(result.args),
        minimized: result.minimized === undefined ? undefined : snapshot(result.minimized),
    };
}
export function fromCloneableResult(result) {
    return {
        symbol: result.symbol,
        ok: result.ok,
        reason: result.reason,
        args: result.args === undefined
            ? undefined
            : deserializeEvent({ args: result.args }).args,
        minimized: result.minimized === undefined
            ? undefined
            : deserializeEvent({ args: result.minimized }).args,
    };
}
function cryptoArgs(symbol, args) {
    if (symbol === "v4" && args.length === 0) {
        return [{ random: globalThis.crypto.getRandomValues(new Uint8Array(16)) }];
    }
    return args;
}
export function withFrozenNow(fn) {
    const now = Date.now();
    const orig = Date.now;
    Date.now = () => now;
    try {
        return fn();
    }
    finally {
        Date.now = orig;
    }
}
export async function runJob(original, replacement, job, persistClock) {
    const origFn = original[job.symbol];
    const slimFn = replacement[job.symbol];
    if (typeof origFn !== "function" || typeof slimFn !== "function") {
        return { symbol: job.symbol, ok: false, reason: `missing function ${job.symbol}`, args: job.args };
    }
    if (job.kind === "debounce" && job.script) {
        const clockOrig = persistClock ?? createFakeClock(0);
        const clockSlim = persistClock ?? createFakeClock(0);
        persistClock?.reset(0);
        const a = await runDebounceScript(origFn, job.script, clockOrig);
        persistClock?.reset(0);
        const b = await runDebounceScript(slimFn, job.script, clockSlim);
        if (!equal(a.spies, b.spies, job.hyrum)) {
            return {
                symbol: job.symbol,
                ok: false,
                reason: "debounce spy timeline mismatch",
                spiesOrig: a.spies,
                spiesSlim: b.spies,
                args: job.args,
            };
        }
        if (!equal(a.returns, b.returns, job.hyrum) || !equal(a.flushResults, b.flushResults, job.hyrum)) {
            return { symbol: job.symbol, ok: false, reason: "debounce return/flush mismatch", args: job.args };
        }
        return { symbol: job.symbol, ok: true };
    }
    const invokeSide = (fn) => withFrozenNow(() => job.cryptoSeed === undefined
        ? invoke(fn, job.args, job.thisArg)
        : withSeededCrypto(job.cryptoSeed, () => invoke(fn, cryptoArgs(job.symbol, job.args), job.thisArg)));
    const pair = {
        o: await settleOutcome(invokeSide(origFn)),
        s: await settleOutcome(invokeSide(slimFn)),
    };
    const cmp = equalResults(pair.o, pair.s, job.hyrum);
    if (cmp.ok) {
        return { symbol: job.symbol, ok: true, args: job.args };
    }
    const pred = (a) => {
        try {
            const trial = () => ({
                o: invoke(origFn, a, job.thisArg),
                s: invoke(slimFn, a, job.thisArg),
            });
            const both = job.cryptoSeed === undefined
                ? trial()
                : {
                    o: withSeededCrypto(job.cryptoSeed, () => invoke(origFn, cryptoArgs(job.symbol, a), job.thisArg)),
                    s: withSeededCrypto(job.cryptoSeed, () => invoke(slimFn, cryptoArgs(job.symbol, a), job.thisArg)),
                };
            return !equalResults(both.o, both.s, job.hyrum).ok;
        }
        catch {
            return false;
        }
    };
    const minimized = minimize(job.args, pred, MINIMIZE_MS);
    return {
        symbol: job.symbol,
        ok: false,
        reason: cmp.reason,
        args: job.args,
        minimized,
    };
}
//# sourceMappingURL=workers.js.map