import { randomUUID } from "node:crypto";
import { createWalker, mutatedArgIndexes, snapshot, } from "./serialize.js";
import { captureUserSite } from "./stack.js";
const SKIP_PROPS = new Set([
    "length",
    "name",
    "prototype",
    "arguments",
    "caller",
    "callee",
    "then",
]);
const wrappedObjects = new WeakSet();
const fnCache = new WeakMap();
const wrapperSymbol = new WeakMap();
let recordDepth = 0;
let sessionId = "";
let sessionStartMs = 0;
function ensureSession() {
    if (!sessionId) {
        sessionId = randomUUID();
        sessionStartMs = Date.now();
    }
}
function isNativeFn(fn) {
    if (wrapperSymbol.has(fn) || wrappedObjects.has(fn))
        return false;
    try {
        return Function.prototype.toString.call(fn).includes("[native code]");
    }
    catch {
        return false;
    }
}
export function wrapExports(exports, opts) {
    if (exports === null || (typeof exports !== "object" && typeof exports !== "function")) {
        return exports;
    }
    const target = exports;
    if (wrappedObjects.has(target))
        return exports;
    if (typeof exports === "function") {
        const wrapped = wrapFn(exports, "default", opts, "", {});
        wrappedObjects.add(wrapped);
        return wrapped;
    }
    const cache = new Map();
    const proxy = new Proxy(target, {
        get(obj, prop, receiver) {
            if (cache.has(prop))
                return cache.get(prop);
            const val = Reflect.get(obj, prop, receiver);
            if (typeof val === "function" && typeof prop === "string" && !SKIP_PROPS.has(prop)) {
                const wrapped = wrapFn(val, prop, opts, prop, {});
                cache.set(prop, wrapped);
                return wrapped;
            }
            return val;
        },
    });
    wrappedObjects.add(proxy);
    return proxy;
}
function wrapFn(fn, symbol, opts, propParent, meta) {
    if (isNativeFn(fn))
        return fn;
    if (wrapperSymbol.get(fn) === symbol) {
        copyFnProps(fn, fn, propParent, opts, meta);
        return fn;
    }
    if (!meta.parentOriginId) {
        const bySymbol = fnCache.get(fn);
        const cached = bySymbol?.get(symbol);
        if (cached)
            return cached;
        const existing = bySymbol?.values().next().value;
        if (existing)
            return aliasWrapped(existing, fn, symbol, opts, meta, propParent);
    }
    if (wrapperSymbol.has(fn)) {
        return aliasWrapped(fn, fn, symbol, opts, meta, propParent);
    }
    const wrapped = makeCallWrapper(fn, symbol, opts, meta);
    cacheWrapper(fn, symbol, wrapped);
    copyFnProps(wrapped, fn, propParent, opts, meta);
    return wrapped;
}
function aliasWrapped(inner, cacheKey, symbol, opts, meta, propParent = symbol) {
    const wrapped = makeCallWrapper(inner, symbol, opts, meta);
    cacheWrapper(cacheKey, symbol, wrapped);
    copyOwnFunctionsShallow(wrapped, inner);
    return wrapped;
}
function copyOwnFunctionsShallow(wrapped, inner) {
    const dest = wrapped;
    const src = inner;
    for (const key of Object.getOwnPropertyNames(inner)) {
        if (SKIP_PROPS.has(key))
            continue;
        const val = src[key];
        if (typeof val === "function") {
            try {
                dest[key] = val;
            }
            catch {
                /* ignore */
            }
        }
    }
}
function cacheWrapper(fn, symbol, wrapped) {
    let bySymbol = fnCache.get(fn);
    if (!bySymbol) {
        bySymbol = new Map();
        fnCache.set(fn, bySymbol);
    }
    bySymbol.set(symbol, wrapped);
    wrapperSymbol.set(wrapped, symbol);
    wrappedObjects.add(wrapped);
    fnCache.set(wrapped, bySymbol);
}
function makeCallWrapper(fn, symbol, opts, meta) {
    const wrapped = function (...args) {
        if (new.target) {
            return recordConstruct(fn, args, new.target, symbol, opts, meta);
        }
        return recordCall(fn, this, args, symbol, opts, meta);
    };
    try {
        Object.defineProperty(wrapped, "name", { value: fn.name, configurable: true });
        Object.defineProperty(wrapped, "length", { value: fn.length, configurable: true });
    }
    catch {
        /* ignore */
    }
    try {
        Object.setPrototypeOf(wrapped, Object.getPrototypeOf(fn));
    }
    catch {
        /* ignore */
    }
    try {
        wrapped.prototype = fn.prototype;
    }
    catch {
        /* ignore */
    }
    return wrapped;
}
function copyFnProps(wrapped, fn, propParent, opts, meta) {
    for (const key of Object.getOwnPropertyNames(fn)) {
        if (SKIP_PROPS.has(key))
            continue;
        let desc;
        try {
            desc = Object.getOwnPropertyDescriptor(fn, key);
        }
        catch {
            continue;
        }
        if (!desc || (desc.get && !("value" in desc)))
            continue;
        const val = fn[key];
        const nestedSymbol = propParent ? `${propParent}.${key}` : key;
        if (typeof val === "function") {
            try {
                wrapped[key] =
                    val === fn
                        ? wrapped
                        : wrapFn(val, nestedSymbol, opts, nestedSymbol, meta.parentOriginId
                            ? { parentOriginId: meta.parentOriginId, resultMember: key }
                            : {});
            }
            catch {
                /* ignore */
            }
        }
        else {
            try {
                wrapped[key] = val;
            }
            catch {
                /* ignore */
            }
        }
    }
}
function emitSerializeError(opts, err) {
    const message = err instanceof Error ? err.message : String(err);
    opts.onError?.({ t: "error", kind: "serialize", message });
}
function isPackageInternal(file) {
    return /(?:^|\/)node_modules\//.test(file.replace(/\\/g, "/"));
}
function recordConstruct(fn, args, newTarget, symbol, opts, meta) {
    ensureSession();
    const originId = randomUUID();
    const tRelMs = Date.now() - sessionStartMs;
    const site = captureUserSite();
    const nested = recordDepth > 0;
    recordDepth++;
    try {
        if (nested || (site && isPackageInternal(site.file))) {
            return Reflect.construct(fn, args, newTarget);
        }
        let walker;
        let beforeLive;
        let beforeSnap;
        try {
            walker = createWalker();
            beforeLive = args.map((a) => walker.value(a));
            beforeSnap = snapshot(args);
        }
        catch (err) {
            emitSerializeError(opts, err);
            return wrapResult(Reflect.construct(fn, args, newTarget), symbol, opts, originId);
        }
        try {
            const result = Reflect.construct(fn, args, newTarget);
            const afterSnap = snapshot(args);
            const recorded = wrapResult(result, symbol, opts, originId);
            const event = {
                symbol,
                originId,
                argc: args.length,
                args: beforeLive,
                result: walker.value(recorded),
                mutatedArgIndexes: mutatedArgIndexes(beforeSnap, afterSnap),
                truncated: walker.truncated,
                tRelMs,
                sessionId,
            };
            if ((event.mutatedArgIndexes ?? []).length)
                event.argsAfter = afterSnap;
            if (meta.parentOriginId)
                event.parentOriginId = meta.parentOriginId;
            if (meta.resultMember !== undefined)
                event.resultMember = meta.resultMember;
            if (site)
                event.site = site;
            opts.onEvent(event);
            return recorded;
        }
        catch (err) {
            const afterSnap = snapshot(args);
            const event = {
                symbol,
                originId,
                argc: args.length,
                args: beforeLive,
                threw: threwShape(err),
                mutatedArgIndexes: mutatedArgIndexes(beforeSnap, afterSnap),
                truncated: walker.truncated,
                tRelMs,
                sessionId,
            };
            if ((event.mutatedArgIndexes ?? []).length)
                event.argsAfter = afterSnap;
            if (meta.parentOriginId)
                event.parentOriginId = meta.parentOriginId;
            if (meta.resultMember !== undefined)
                event.resultMember = meta.resultMember;
            if (site)
                event.site = site;
            opts.onEvent(event);
            throw err;
        }
    }
    finally {
        recordDepth--;
    }
}
function recordCall(fn, thisArg, args, symbol, opts, meta) {
    ensureSession();
    const originId = randomUUID();
    const tRelMs = Date.now() - sessionStartMs;
    const site = captureUserSite();
    const nested = recordDepth > 0;
    recordDepth++;
    try {
        if (nested || (site && isPackageInternal(site.file))) {
            return fn.apply(thisArg, args);
        }
        let walker;
        let beforeLive;
        let thisSv;
        let beforeSnap;
        try {
            walker = createWalker();
            beforeLive = args.map((a) => walker.value(a));
            thisSv = shouldRecordThis(thisArg) ? walker.value(thisArg) : undefined;
            beforeSnap = snapshot(args);
        }
        catch (err) {
            emitSerializeError(opts, err);
            const result = fn.apply(thisArg, args);
            return wrapResult(result, symbol, opts, originId);
        }
        try {
            const result = fn.apply(thisArg, args);
            const after = snapshotAfter(args, thisArg, thisSv !== undefined);
            const recorded = wrapResult(result, symbol, opts, originId);
            const event = {
                symbol,
                originId,
                argc: args.length,
                args: beforeLive,
                result: walker.value(recorded),
                mutatedArgIndexes: mutatedArgIndexes(beforeSnap, after.args),
                truncated: walker.truncated,
                tRelMs,
                sessionId,
            };
            if ((event.mutatedArgIndexes ?? []).length)
                event.argsAfter = after.args;
            if (thisSv !== undefined) {
                event.thisArg = thisSv;
                event.thisAfter = after.thisArg;
            }
            if (meta.parentOriginId)
                event.parentOriginId = meta.parentOriginId;
            if (meta.resultMember !== undefined)
                event.resultMember = meta.resultMember;
            if (site)
                event.site = site;
            opts.onEvent(event);
            return recorded;
        }
        catch (err) {
            const after = snapshotAfter(args, thisArg, thisSv !== undefined);
            const event = {
                symbol,
                originId,
                argc: args.length,
                args: beforeLive,
                threw: threwShape(err),
                mutatedArgIndexes: mutatedArgIndexes(beforeSnap, after.args),
                truncated: walker.truncated,
                tRelMs,
                sessionId,
            };
            if ((event.mutatedArgIndexes ?? []).length)
                event.argsAfter = after.args;
            if (thisSv !== undefined) {
                event.thisArg = thisSv;
                event.thisAfter = after.thisArg;
            }
            if (meta.parentOriginId)
                event.parentOriginId = meta.parentOriginId;
            if (meta.resultMember !== undefined)
                event.resultMember = meta.resultMember;
            if (site)
                event.site = site;
            opts.onEvent(event);
            throw err;
        }
    }
    finally {
        recordDepth--;
    }
}
function wrapResult(result, symbol, opts, parentOriginId) {
    if (typeof result === "function") {
        return wrapFn(result, `${symbol}()`, opts, symbol, { parentOriginId, resultMember: "" });
    }
    if (result instanceof Promise) {
        return result.then((v) => wrapResult(v, symbol, opts, parentOriginId));
    }
    if (isThenable(result)) {
        const orig = result;
        return {
            then(onFulfilled, onRejected) {
                return orig.then((v) => {
                    const next = wrapResult(v, symbol, opts, parentOriginId);
                    return onFulfilled ? onFulfilled(next) : next;
                }, onRejected);
            },
        };
    }
    return result;
}
function isThenable(v) {
    return Boolean(v &&
        (typeof v === "object" || typeof v === "function") &&
        typeof v.then === "function");
}
function shouldRecordThis(thisArg) {
    if (thisArg === undefined || thisArg === null)
        return false;
    if (thisArg === globalThis)
        return false;
    return typeof thisArg === "object" || typeof thisArg === "function";
}
function snapshotAfter(args, thisArg, recordThis) {
    const w = createWalker();
    return {
        args: args.map((a) => w.value(a)),
        thisArg: recordThis ? w.value(thisArg) : undefined,
    };
}
function threwShape(err) {
    if (err instanceof Error) {
        const code = err.code;
        return {
            name: err.name,
            message: err.message,
            ...(typeof code === "string" || typeof code === "number"
                ? { code: String(code) }
                : {}),
        };
    }
    return { name: "Error", message: String(err) };
}
//# sourceMappingURL=proxy.js.map