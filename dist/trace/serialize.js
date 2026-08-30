import { createHash } from "node:crypto";
const REDACT_RE = /password|token|secret|authorization/i;
const MAX_STRING = 4096; /* ponytail: 4KiB cap */
const PROTO_TAG = Symbol.for("slim.protoTag");
const OTHER_PROTO = Object.freeze(Object.create(null));
const DEFAULT_BUDGET = 10_000;
const SOURCE_HINT = /\b(module\.exports|export\s+(?:default|async|function|const|class)|function\s+[A-Za-z_$])/;
const STACK_HINT = /(?:^|\n)\s+at\s+\S+.+:\d+:\d+/;
export function serialize(value, opts) {
    const st = newState(opts?.budget);
    return walk(value, st);
}
export function deserialize(v) {
    const seen = [];
    return decode(v, seen);
}
export function snapshot(args) {
    const st = newState();
    return args.map((a) => walk(a, st));
}
export function serializeEvent(input) {
    const st = newState();
    const args = input.args.map((a) => walk(a, st));
    const thisArg = input.thisArg === undefined ? undefined : walk(input.thisArg, st);
    const result = input.result === undefined ? undefined : walk(input.result, st);
    return {
        args,
        ...(thisArg !== undefined ? { thisArg } : {}),
        ...(result !== undefined ? { result } : {}),
        truncated: st.budget.truncated,
    };
}
export function deserializeEvent(e) {
    const seen = [];
    const args = e.args.map((a) => decode(a, seen));
    const thisArg = e.thisArg === undefined ? undefined : decode(e.thisArg, seen);
    const result = e.result === undefined ? undefined : decode(e.result, seen);
    return {
        args,
        ...(thisArg !== undefined ? { thisArg } : {}),
        ...(result !== undefined ? { result } : {}),
    };
}
export function mutatedArgIndexes(before, after) {
    const n = Math.max(before.length, after.length);
    const out = [];
    for (let i = 0; i < n; i++) {
        if (!slimEq(before[i], after[i]))
            out.push(i);
    }
    return out;
}
export function createWalker(budget) {
    const st = newState(budget);
    return {
        value(v) {
            return walk(v, st);
        },
        get truncated() {
            return st.budget.truncated;
        },
    };
}
function newState(budget = DEFAULT_BUDGET) {
    return {
        seen: new Map(),
        ids: { next: 0 },
        budget: { n: budget, truncated: false },
    };
}
function walk(value, st) {
    if (st.budget.n <= 0) {
        st.budget.truncated = true;
        return { t: "trunc" };
    }
    st.budget.n--;
    if (value === undefined)
        return { t: "undef" };
    if (value === null)
        return { t: "null" };
    if (typeof value === "boolean")
        return { t: "bool", v: value };
    if (typeof value === "string")
        return serializeString(value);
    if (typeof value === "bigint")
        return { t: "bigint", v: value.toString() };
    if (typeof value === "symbol")
        return { t: "str", v: value.toString() };
    if (typeof value === "number") {
        if (Number.isNaN(value))
            return { t: "num", v: "NaN" };
        if (value === Infinity)
            return { t: "num", v: "Infinity" };
        if (value === -Infinity)
            return { t: "num", v: "-Infinity" };
        if (Object.is(value, -0))
            return { t: "num", v: "-0" };
        return { t: "num", v: value };
    }
    if (typeof value === "function" || (typeof value === "object" && value !== null)) {
        const obj = value;
        const existing = st.seen.get(obj);
        if (existing !== undefined)
            return { t: "ref", id: existing };
        const id = st.ids.next++;
        st.seen.set(obj, id);
    }
    else {
        return { t: "undef" };
    }
    if (typeof value === "function") {
        return {
            t: "fn",
            ...(value.name ? { name: value.name } : {}),
            length: value.length,
        };
    }
    if (value instanceof Promise)
        return { t: "promise" };
    if (value instanceof Date)
        return { t: "date", v: value.getTime() };
    if (value instanceof RegExp) {
        return { t: "regexp", source: value.source, flags: value.flags };
    }
    if (value instanceof Error) {
        const err = value;
        return {
            t: "err",
            name: err.name,
            message: err.message,
            ...(err.code !== undefined ? { code: err.code } : {}),
        };
    }
    if (value instanceof Uint8Array) {
        const out = { t: "bytes", kind: "u8", len: value.length };
        if (value.length <= 256) {
            out.b64 = Buffer.from(value).toString("base64");
        }
        return out;
    }
    if (value instanceof Map) {
        const entries = [];
        for (const [k, val] of value.entries()) {
            const keySv = walk(k, st);
            const valSv = typeof k === "string" && REDACT_RE.test(k) ? redacted() : walk(val, st);
            entries.push([keySv, valSv]);
        }
        return { t: "map", v: entries };
    }
    if (value instanceof Set) {
        const items = [];
        for (const item of value)
            items.push(walk(item, st));
        return { t: "set", v: items };
    }
    if (Array.isArray(value)) {
        const holes = [];
        const items = [];
        for (let i = 0; i < value.length; i++) {
            if (!(i in value)) {
                holes.push(i);
                items.push({ t: "undef" });
            }
            else {
                items.push(walk(value[i], st));
            }
        }
        return { t: "arr", v: items, holes };
    }
    const keys = ownStringKeys(value);
    const fields = Object.create(null);
    for (const k of keys) {
        const child = REDACT_RE.test(k)
            ? redacted()
            : walk(value[k], st);
        defineOwn(fields, k, child);
    }
    const rec = value;
    const toStr = typeof rec.toString === "function" && rec.toString !== Object.prototype.toString;
    const proto = protoTag(value);
    const syms = ownSymbolKeys(value, st);
    let str;
    if (toStr) {
        try {
            const s = String(value);
            str = s.length > MAX_STRING ? s.slice(0, MAX_STRING) : s;
        }
        catch {
            str = undefined;
        }
    }
    let json;
    if (typeof rec.toJSON === "function") {
        try {
            const js = JSON.stringify(value);
            if (typeof js === "string")
                json = js.length > MAX_STRING ? js.slice(0, MAX_STRING) : js;
        }
        catch {
            json = undefined;
        }
    }
    return {
        t: "obj",
        keys,
        v: fields,
        ...(proto !== "object" ? { proto } : {}),
        ...(toStr ? { toStr: true } : {}),
        ...(str !== undefined ? { str } : {}),
        ...(json !== undefined ? { json } : {}),
        ...(syms.length ? { syms } : {}),
    };
}
function protoTag(value) {
    const p = Object.getPrototypeOf(value);
    if (p === null)
        return "null";
    if (p === Object.prototype)
        return "object";
    return "other";
}
function ownSymbolKeys(value, st) {
    const out = [];
    for (const k of Reflect.ownKeys(value)) {
        if (typeof k !== "symbol")
            continue;
        const d = Object.getOwnPropertyDescriptor(value, k);
        if (d?.enumerable !== true)
            continue;
        const globalKey = Symbol.keyFor(k);
        const name = globalKey ?? k.description ?? "";
        const raw = d.value !== undefined || "value" in d ? d.value : undefined;
        const child = typeof name === "string" && REDACT_RE.test(name) ? redacted() : walk(raw, st);
        out.push(globalKey !== undefined ? { k: name, g: true, v: child } : { k: name, v: child });
    }
    return out;
}
function ownStringKeys(value) {
    return Reflect.ownKeys(value).filter((k) => typeof k === "string");
}
function defineOwn(o, key, value) {
    Object.defineProperty(o, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
    });
}
function serializeString(s) {
    if (REDACT_RE.test(s) || looksLikeSource(s) || looksLikeStack(s) || looksLikeSourceMap(s)) {
        return redacted();
    }
    if (s.length > MAX_STRING) {
        const hash = createHash("sha256").update(s).digest("hex");
        return { t: "str", v: s.slice(0, MAX_STRING) + "\nsha256:" + hash };
    }
    return { t: "str", v: s };
}
function looksLikeSource(s) {
    return s.includes("\n") && s.length >= 80 && SOURCE_HINT.test(s);
}
function looksLikeSourceMap(s) {
    return s.includes('"mappings"') && s.includes('"sourcesContent"') && /"version"\s*:\s*3/.test(s);
}
function looksLikeStack(s) {
    if (!s.includes("\n") || !STACK_HINT.test(s))
        return false;
    return (s.match(/\n\s+at\s+/g) ?? []).length >= 2;
}
function redacted() {
    return { t: "str", v: "[redacted]", redacted: true };
}
function decode(v, seen) {
    if (!v)
        return undefined;
    switch (v.t) {
        case "undef":
        case "trunc":
            return undefined;
        case "null":
            return null;
        case "bool":
            return v.v;
        case "num":
            if (v.v === "NaN")
                return NaN;
            if (v.v === "-0")
                return -0;
            if (v.v === "Infinity")
                return Infinity;
            if (v.v === "-Infinity")
                return -Infinity;
            return v.v;
        case "str":
            return v.v;
        case "bigint":
            return BigInt(v.v);
        case "date": {
            const d = new Date(v.v);
            seen.push(d);
            return d;
        }
        case "err": {
            const e = new Error(v.message);
            e.name = v.name;
            if (v.code !== undefined)
                e.code = v.code;
            seen.push(e);
            return e;
        }
        case "fn": {
            const f = function noop() { };
            try {
                Object.defineProperty(f, "name", { value: v.name ?? "", configurable: true });
                Object.defineProperty(f, "length", { value: v.length ?? 0, configurable: true });
            }
            catch {
                /* ignore */
            }
            seen.push(f);
            return f;
        }
        case "arr": {
            const a = new Array(v.v.length);
            seen.push(a);
            for (let i = 0; i < v.v.length; i++) {
                if (v.holes.includes(i))
                    continue;
                a[i] = decode(v.v[i], seen);
            }
            return a;
        }
        case "obj": {
            const o = Object.create(null);
            seen.push(o);
            for (const k of v.keys)
                defineOwn(o, k, decode(v.v[k], seen));
            for (const s of v.syms ?? []) {
                const sym = s.g ? Symbol.for(s.k) : Symbol(s.k);
                defineOwn(o, sym, decode(s.v, seen));
            }
            const proto = v.proto ?? "object";
            Object.defineProperty(o, PROTO_TAG, { value: proto, enumerable: false, configurable: true });
            if (proto === "object")
                Object.setPrototypeOf(o, Object.prototype);
            else if (proto === "other")
                Object.setPrototypeOf(o, OTHER_PROTO);
            if (typeof v.str === "string") {
                const s = v.str;
                Object.defineProperty(o, "toString", {
                    value() {
                        return s;
                    },
                    enumerable: true,
                    writable: true,
                    configurable: true,
                });
            }
            if (typeof v.json === "string") {
                const j = v.json;
                Object.defineProperty(o, "toJSON", {
                    value() {
                        try {
                            return JSON.parse(j);
                        }
                        catch {
                            return undefined;
                        }
                    },
                    enumerable: true,
                    writable: true,
                    configurable: true,
                });
            }
            return o;
        }
        case "map": {
            const m = new Map();
            seen.push(m);
            for (const [k, val] of v.v)
                m.set(decode(k, seen), decode(val, seen));
            return m;
        }
        case "set": {
            const s = new Set();
            seen.push(s);
            for (const item of v.v)
                s.add(decode(item, seen));
            return s;
        }
        case "ref":
            return seen[v.id];
        case "promise": {
            const p = Promise.resolve();
            seen.push(p);
            return p;
        }
        case "regexp": {
            const r = new RegExp(v.source, v.flags);
            seen.push(r);
            return r;
        }
        case "bytes": {
            const u8 = v.b64
                ? Uint8Array.from(Buffer.from(v.b64, "base64"))
                : new Uint8Array(v.len ?? 0);
            seen.push(u8);
            return u8;
        }
        default:
            return undefined;
    }
}
function slimEq(a, b) {
    if (a === b)
        return true;
    if (!a || !b)
        return a === b;
    if (a.t !== b.t)
        return false;
    switch (a.t) {
        case "undef":
        case "null":
        case "promise":
        case "trunc":
            return true;
        case "bool":
        case "num":
        case "str":
        case "bigint":
        case "date":
            return a.v === b.v &&
                (a.t !== "str" || a.redacted === b.redacted);
        case "err":
            return (b.t === "err" &&
                a.name === b.name &&
                a.message === b.message &&
                a.code === b.code);
        case "fn":
            return b.t === "fn" && a.name === b.name && a.length === b.length;
        case "arr":
            return (b.t === "arr" &&
                a.holes.length === b.holes.length &&
                a.holes.every((h, i) => h === b.holes[i]) &&
                a.v.length === b.v.length &&
                a.v.every((x, i) => slimEq(x, b.v[i])));
        case "obj":
            return (b.t === "obj" &&
                a.keys.length === b.keys.length &&
                a.keys.every((k, i) => k === b.keys[i] && slimEq(a.v[k], b.v[k])) &&
                a.proto === b.proto &&
                a.toStr === b.toStr &&
                a.str === b.str &&
                a.json === b.json &&
                slimEqSyms(a.syms, b.syms));
        case "map":
            return (b.t === "map" &&
                a.v.length === b.v.length &&
                a.v.every((pair, i) => slimEq(pair[0], b.v[i]?.[0]) && slimEq(pair[1], b.v[i]?.[1])));
        case "set": {
            if (b.t !== "set" || a.v.length !== b.v.length)
                return false;
            const unused = b.v.slice();
            for (const x of a.v) {
                const idx = unused.findIndex((y) => slimEq(x, y));
                if (idx < 0)
                    return false;
                unused.splice(idx, 1);
            }
            return true;
        }
        case "bytes":
            return b.t === "bytes" && a.kind === b.kind && a.len === b.len && a.b64 === b.b64;
        case "ref":
            return b.t === "ref" && a.id === b.id;
        case "regexp":
            return b.t === "regexp" && a.source === b.source && a.flags === b.flags;
        default:
            return false;
    }
}
function slimEqSyms(a, b) {
    const aa = a ?? [];
    const bb = b ?? [];
    if (aa.length !== bb.length)
        return false;
    return aa.every((s, i) => s.k === bb[i]?.k && s.g === bb[i]?.g && slimEq(s.v, bb[i]?.v));
}
//# sourceMappingURL=serialize.js.map