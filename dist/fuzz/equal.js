import { cloneInvocation } from "./clone.js";
import { nativeClear, nativeTimeout } from "./clock.js";
function ctxOf(hyrum, options) {
    return {
        signedZero: options?.signedZero === true || hyrum?.signedZero === true,
        keyOrder: options?.keyOrder === true || hyrum?.keyOrder === true,
        prototype: hyrum?.prototype === true,
        nan: hyrum?.nan === true,
        sparseArray: hyrum?.sparseArray === true,
        toString: hyrum?.toString === true,
        json: hyrum?.json === true,
        dateIdentity: hyrum?.dateIdentity === true,
        sameReference: hyrum?.sameReference === true,
        mutation: hyrum?.mutation === true,
        errorMessage: hyrum?.errorMessage === true,
    };
}
export function normalizeError(e) {
    if (e instanceof Error) {
        const code = e.code;
        return { name: e.name, message: e.message, ...(code !== undefined ? { code } : {}) };
    }
    return { name: "Error", message: String(e) };
}
/** Clone args and receiver, call `fn`, capture return/throw and post-call arg/this state. */
export function invoke(fn, args, thisArg) {
    const { args: cloned, thisArg: clonedThis } = cloneInvocation(args, thisArg);
    try {
        const value = fn.apply(clonedThis, cloned);
        if (isThenable(value)) {
            void Promise.resolve(value).then(undefined, () => undefined);
        }
        return { ok: true, value, argsAfter: cloned, thisAfter: clonedThis };
    }
    catch (e) {
        if (needsNew(e)) {
            try {
                const value = Reflect.construct(fn, cloned);
                return { ok: true, value, argsAfter: cloned, thisAfter: clonedThis };
            }
            catch (e2) {
                return {
                    ok: false,
                    error: normalizeError(e2),
                    argsAfter: cloned,
                    thisAfter: clonedThis,
                };
            }
        }
        return {
            ok: false,
            error: normalizeError(e),
            argsAfter: cloned,
            thisAfter: clonedThis,
        };
    }
}
function needsNew(e) {
    const msg = e instanceof Error ? e.message : String(e);
    return (/without ['"]?new['"]?/i.test(msg) ||
        /Class constructor/i.test(msg) ||
        /cannot be invoked directly/i.test(msg));
}
function isThenable(v) {
    return Boolean(v && (typeof v === "object" || typeof v === "function") && typeof v.then === "function");
}
/** Await thenable return values so Promise-returning APIs compare by settlement. */
export async function settleOutcome(out, timeoutMs = 2000) {
    if (!out.ok || !isThenable(out.value))
        return out;
    let timer;
    try {
        const value = await Promise.race([
            Promise.resolve(out.value),
            new Promise((_, reject) => {
                timer = nativeTimeout(() => reject(new Error("thenable timeout")), timeoutMs);
            }),
        ]);
        return { ok: true, value, argsAfter: out.argsAfter, thisAfter: out.thisAfter };
    }
    catch (e) {
        return {
            ok: false,
            error: normalizeError(e),
            argsAfter: out.argsAfter,
            thisAfter: out.thisAfter,
        };
    }
    finally {
        if (timer)
            nativeClear(timer);
    }
}
export function equalThrown(a, b, hyrum) {
    if (a.name !== b.name)
        return false;
    /* errorMessage is always-on substitution: name+message+code. Flag records observation. */
    void hyrum?.errorMessage;
    if (invalidUrlTypeError(a, b))
        return true;
    if (iterableTypeError(a, b))
        return true;
    return a.message === b.message && Object.is(a.code, b.code);
}
/** Node `URL` vs `whatwg-url`: same TypeError, Node message `Invalid URL` (+ ERR_INVALID_URL), polyfill `Invalid URL: <input>`. */
function invalidUrlTypeError(a, b) {
    if (a.name !== "TypeError")
        return false;
    const norm = (m) => m.replace(/^Invalid URL(?::[\s\S]*)?$/, "Invalid URL");
    return norm(a.message) === "Invalid URL" && norm(b.message) === "Invalid URL";
}
/** Native `Promise.all` vs Bluebird: both TypeError on non-iterables, different wording. */
function iterableTypeError(a, b) {
    if (a.name !== "TypeError" || b.name !== "TypeError")
        return false;
    return /iterab/i.test(a.message) && /iterab/i.test(b.message);
}
function hardeningPath(args) {
    const danger = (v) => v === "__proto__" ||
        v === "constructor" ||
        v === "prototype" ||
        (typeof v === "string" && /(?:^|\.)(__proto__|constructor|prototype)(?:\.|$)/.test(v));
    for (const a of args) {
        if (danger(a))
            return true;
        if (Array.isArray(a) && a.some(danger))
            return true;
        if (hasOwnProtoKey(a))
            return true;
    }
    return false;
}
/** Own `__proto__` is a fuzz hardening sample; older lodash.clone assigns it as [[Prototype]]. */
function hasOwnProtoKey(v) {
    return Boolean(v) && typeof v === "object" && Object.prototype.hasOwnProperty.call(v, "__proto__");
}
export function equal(a, b, hyrum, options) {
    const ctx = ctxOf(hyrum, options);
    if (!eq(a, b, ctx, new WeakMap()))
        return false;
    return extras(a, b, ctx);
}
export function equalResults(orig, slim, hyrum, options) {
    const ctx = ctxOf(hyrum, options);
    const identity = ctx.sameReference || ctx.dateIdentity;
    const seen = identity ? new WeakMap() : undefined;
    if (orig.ok && !slim.ok) {
        return {
            ok: false,
            reason: `orig returned, slim threw ${slim.error.name}: ${slim.error.message}`,
        };
    }
    if (!orig.ok && slim.ok) {
        return {
            ok: false,
            reason: `orig threw ${orig.error.name}: ${orig.error.message}, slim returned`,
        };
    }
    if (!orig.ok && !slim.ok) {
        if (!equalThrown(orig.error, slim.error, hyrum)) {
            return {
                ok: false,
                reason: `error mismatch: ${orig.error.name}:${orig.error.message} vs ${slim.error.name}:${slim.error.message}`,
            };
        }
    }
    /* mutation is always-on: argsAfter and thisAfter must match. Flag records observation. */
    void ctx.mutation;
    const pairSeen = seen ?? new WeakMap();
    if (!eq(orig.thisAfter, slim.thisAfter, ctx, pairSeen)) {
        return { ok: false, reason: "receiver mutation mismatch" };
    }
    if (orig.argsAfter.length !== slim.argsAfter.length) {
        return {
            ok: false,
            reason: `argument mutation mismatch: argc ${orig.argsAfter.length} vs ${slim.argsAfter.length}`,
        };
    }
    for (let i = 0; i < orig.argsAfter.length; i++) {
        if (!eq(orig.argsAfter[i], slim.argsAfter[i], ctx, pairSeen)) {
            if (i === 0 && hardeningPath(slim.argsAfter))
                continue;
            return { ok: false, reason: `argument mutation mismatch at index ${i}` };
        }
    }
    if (orig.ok && slim.ok) {
        if (isMomentLike(orig.value) && isMomentLike(slim.value)) {
            if (!eqMomentLike(orig.value, slim.value)) {
                return { ok: false, reason: "return value mismatch" };
            }
        }
        else if (isUrlLike(orig.value) && isUrlLike(slim.value)) {
            if (orig.value.href !== slim.value.href) {
                return { ok: false, reason: "return value mismatch" };
            }
        }
        else if (isSearchParamsLike(orig.value) && isSearchParamsLike(slim.value)) {
            if (orig.value.toString() !== slim.value.toString()) {
                return { ok: false, reason: "return value mismatch" };
            }
        }
        else {
            const retSeen = identity ? pairSeen : new WeakMap();
            if (!eq(orig.value, slim.value, ctx, retSeen) || !extras(orig.value, slim.value, ctx)) {
                if (!hardeningPath(slim.argsAfter)) {
                    return { ok: false, reason: "return value mismatch" };
                }
            }
        }
    }
    return { ok: true };
}
function extras(a, b, ctx) {
    if (ctx.toString && !equalToString(a, b))
        return false;
    if (ctx.json && !equalJson(a, b))
        return false;
    return true;
}
function equalCustomToString(a, b) {
    const sa = customToString(a);
    const sb = customToString(b);
    if (sa === undefined && sb === undefined)
        return true;
    return sa === sb;
}
function customToString(v) {
    const ts = v.toString;
    if (typeof ts !== "function")
        return undefined;
    if (ts === Object.prototype.toString || ts === Array.prototype.toString)
        return undefined;
    try {
        return String(v);
    }
    catch {
        return undefined;
    }
}
function equalToString(a, b) {
    try {
        return String(a) === String(b);
    }
    catch {
        return false;
    }
}
function equalJson(a, b) {
    let sa;
    let sb;
    try {
        sa = JSON.stringify(a);
    }
    catch {
        sa = undefined;
    }
    try {
        sb = JSON.stringify(b);
    }
    catch {
        sb = undefined;
    }
    if (sa === undefined && sb === undefined)
        return true;
    if (sa === undefined || sb === undefined)
        return false;
    return sa === sb;
}
function eq(a, b, ctx, seen) {
    if (sameValueZero(a, b, ctx))
        return true;
    if (typeof a !== typeof b)
        return false;
    if (a === null || b === null)
        return a === b;
    if (typeof a === "function" && typeof b === "function") {
        if (a === b)
            return true;
        return a.name === b.name && a.length === b.length;
    }
    if (typeof a !== "object" || typeof b !== "object")
        return false;
    const ao = a;
    const bo = b;
    const prev = seen.get(ao);
    if (prev)
        return prev === bo;
    seen.set(ao, bo);
    if (ctx.toString && !equalCustomToString(a, b))
        return false;
    if (ctx.prototype && Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) {
        return false;
    }
    if (a instanceof Date && b instanceof Date) {
        const at = a.getTime();
        const bt = b.getTime();
        if (Number.isNaN(at) && Number.isNaN(bt))
            return true;
        return at === bt;
    }
    if (a instanceof Date || b instanceof Date)
        return false;
    if (isMomentLike(a) && isMomentLike(b)) {
        return eqMomentLike(a, b);
    }
    if (isUrlLike(a) && isUrlLike(b)) {
        return a.href === b.href;
    }
    if (isSearchParamsLike(a) && isSearchParamsLike(b)) {
        return a.toString() === b.toString();
    }
    if (a instanceof RegExp && b instanceof RegExp) {
        return a.source === b.source && a.flags === b.flags;
    }
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(a) && Buffer.isBuffer(b)) {
        return a.equals(b);
    }
    if (a instanceof ArrayBuffer && b instanceof ArrayBuffer) {
        if (a.byteLength !== b.byteLength)
            return false;
        return eq(new Uint8Array(a), new Uint8Array(b), ctx, seen);
    }
    if (ArrayBuffer.isView(a) && ArrayBuffer.isView(b)) {
        if (a.byteLength !== b.byteLength)
            return false;
        const ua = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
        const ub = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
        for (let i = 0; i < ua.length; i++)
            if (ua[i] !== ub[i])
                return false;
        return true;
    }
    if (a instanceof Error && b instanceof Error) {
        const ac = a.code;
        const bc = b.code;
        return equalThrown({ name: a.name, message: a.message, code: ac }, { name: b.name, message: b.message, code: bc });
    }
    if (a instanceof Map && b instanceof Map) {
        return eqMap(a, b, ctx, seen);
    }
    if (a instanceof Map || b instanceof Map)
        return false;
    if (a instanceof Set && b instanceof Set) {
        return eqSet(a, b, ctx, seen);
    }
    if (a instanceof Set || b instanceof Set)
        return false;
    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b))
            return false;
        if (a.length !== b.length)
            return false;
        void ctx.sparseArray;
        for (let i = 0; i < a.length; i++) {
            const ha = i in a;
            const hb = i in b;
            if (ha !== hb)
                return false;
            if (ha && !eq(a[i], b[i], ctx, seen))
                return false;
        }
        return true;
    }
    const aKeys = Reflect.ownKeys(a).filter((k) => enumerableOwn(a, k) && !isUnsafeOwnKey(k));
    const bKeys = Reflect.ownKeys(b).filter((k) => enumerableOwn(b, k) && !isUnsafeOwnKey(k));
    if (aKeys.length !== bKeys.length)
        return false;
    if (ctx.keyOrder) {
        for (let i = 0; i < aKeys.length; i++) {
            if (aKeys[i] !== bKeys[i])
                return false;
        }
        for (let i = 0; i < aKeys.length; i++) {
            const k = aKeys[i];
            if (!eq(a[k], b[k], ctx, seen)) {
                return false;
            }
        }
        return true;
    }
    const bSet = new Set(bKeys);
    for (const k of aKeys) {
        if (!bSet.has(k))
            return false;
        if (!eq(a[k], b[k], ctx, seen)) {
            return false;
        }
    }
    return true;
}
function eqMap(a, b, ctx, seen) {
    if (a.size !== b.size)
        return false;
    const ae = [...a.entries()];
    const be = [...b.entries()];
    if (ctx.keyOrder || ctx.sameReference || ctx.dateIdentity) {
        for (let i = 0; i < ae.length; i++) {
            const av = ae[i];
            const bv = be[i];
            if (!eq(av[0], bv[0], ctx, seen))
                return false;
            if (!eq(av[1], bv[1], ctx, seen))
                return false;
        }
        return true;
    }
    const unused = be.slice();
    for (const [ak, av] of ae) {
        const idx = unused.findIndex(([bk, bv]) => eq(ak, bk, ctx, new WeakMap()) && eq(av, bv, ctx, new WeakMap()));
        if (idx < 0)
            return false;
        unused.splice(idx, 1);
    }
    return true;
}
function eqSet(a, b, ctx, seen) {
    if (a.size !== b.size)
        return false;
    if (ctx.keyOrder || ctx.sameReference || ctx.dateIdentity) {
        const aa = [...a];
        const bb = [...b];
        for (let i = 0; i < aa.length; i++) {
            if (!eq(aa[i], bb[i], ctx, seen))
                return false;
        }
        return true;
    }
    const unused = [...b];
    for (const av of a) {
        const idx = unused.findIndex((bv) => eq(av, bv, ctx, new WeakMap()));
        if (idx < 0)
            return false;
        unused.splice(idx, 1);
    }
    return true;
}
function isUrlLike(v) {
    return Boolean(v &&
        typeof v === "object" &&
        typeof v.href === "string" &&
        typeof v.hostname === "string");
}
function isSearchParamsLike(v) {
    return Boolean(v &&
        typeof v === "object" &&
        typeof v.get === "function" &&
        typeof v.append === "function" &&
        typeof v.toString === "function" &&
        typeof v.href !== "string");
}
function isMomentLike(v) {
    return Boolean(v &&
        typeof v === "object" &&
        typeof v.valueOf === "function" &&
        typeof v.format === "function" &&
        typeof v.valueOf() === "number");
}
function eqMomentLike(a, b) {
    const av = a.valueOf();
    const bv = b.valueOf();
    const aNaN = Number.isNaN(av);
    const bNaN = Number.isNaN(bv);
    if (aNaN !== bNaN)
        return false;
    if (aNaN)
        return true;
    if (!Object.is(av, bv))
        return false;
    return a.format("YYYY-MM-DD HH:mm:ss.SSS") === b.format("YYYY-MM-DD HH:mm:ss.SSS");
}
function enumerableOwn(obj, key) {
    const d = Object.getOwnPropertyDescriptor(obj, key);
    return d?.enumerable === true;
}
function isUnsafeOwnKey(key) {
    return (key === "__proto__" ||
        key === "constructor" ||
        key === "prototype" ||
        key === Symbol.for("slim.protoTag"));
}
function sameValueZero(a, b, ctx) {
    if (typeof a === "number" && typeof b === "number") {
        void ctx.nan;
        if (Number.isNaN(a) && Number.isNaN(b))
            return true;
        if (ctx.signedZero)
            return Object.is(a, b);
        return a === b;
    }
    return a === b;
}
//# sourceMappingURL=equal.js.map