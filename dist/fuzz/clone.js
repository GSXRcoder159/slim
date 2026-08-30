/**
 * Deep clone of call arguments so orig and slim cannot share mutable state.
 * Functions are returned by reference (not cloned). Cycles use WeakMap.
 */
export function clone(value, seen = new WeakMap()) {
    if (value === null || typeof value !== "object")
        return value;
    if (typeof value === "function")
        return value;
    const obj = value;
    const cached = seen.get(obj);
    if (cached !== undefined)
        return cached;
    if (value instanceof Date) {
        const c = new Date(value.getTime());
        seen.set(obj, c);
        return c;
    }
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
        const c = Buffer.from(value);
        seen.set(obj, c);
        return c;
    }
    if (value instanceof ArrayBuffer) {
        const c = value.slice(0);
        seen.set(obj, c);
        return c;
    }
    if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
        const Ctor = value.constructor;
        const c = new Ctor(value);
        seen.set(obj, c);
        return c;
    }
    if (value instanceof DataView) {
        const buf = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
        const c = new DataView(buf);
        seen.set(obj, c);
        return c;
    }
    if (value instanceof Map) {
        const c = new Map();
        seen.set(obj, c);
        for (const [k, v] of value)
            c.set(clone(k, seen), clone(v, seen));
        return c;
    }
    if (value instanceof Set) {
        const c = new Set();
        seen.set(obj, c);
        for (const v of value)
            c.add(clone(v, seen));
        return c;
    }
    if (value instanceof Error) {
        const Ctor = value.constructor;
        const c = new Ctor(value.message);
        seen.set(obj, c);
        c.name = value.name;
        c.stack = value.stack;
        if ("code" in value) {
            c.code = value.code;
        }
        if ("cause" in value) {
            c.cause = clone(value.cause, seen);
        }
        return c;
    }
    if (value instanceof RegExp) {
        const c = new RegExp(value.source, value.flags);
        seen.set(obj, c);
        return c;
    }
    if (Array.isArray(value)) {
        const c = new Array(value.length);
        seen.set(obj, c);
        for (let i = 0; i < value.length; i++) {
            if (i in value)
                c[i] = clone(value[i], seen);
        }
        return c;
    }
    const proto = Object.getPrototypeOf(value);
    const c = Object.create(proto);
    seen.set(obj, c);
    for (const key of Reflect.ownKeys(value)) {
        const desc = Object.getOwnPropertyDescriptor(value, key);
        if (!desc)
            continue;
        if (desc.value !== undefined || "value" in desc) {
            Object.defineProperty(c, key, {
                ...desc,
                value: typeof desc.value === "function" ? desc.value : clone(desc.value, seen),
            });
        }
        else {
            Object.defineProperty(c, key, desc);
        }
    }
    return c;
}
/** One WeakMap across args and the receiver so aliases and cycles survive isolation clones. */
export function cloneInvocation(args, thisArg) {
    const seen = new WeakMap();
    return {
        args: args.map((a) => clone(a, seen)),
        thisArg: thisArg === undefined || thisArg === null ? thisArg : clone(thisArg, seen),
    };
}
//# sourceMappingURL=clone.js.map