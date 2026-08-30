/**
 * MIT License
 *
 * Copyright (c) 2026 Slim contributors
 *
 * Original Slim helpers for catalog lodash slices. Not affiliated with lodash authors.
 */
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const DANGEROUS = new Set(["__proto__", "constructor", "prototype"]);
const DEEP_PATH = /[.[\]]/;
const UINT = /^(?:0|[1-9]\d*)$/;
const TAG = Object.prototype.toString;
export function getTag(value) {
    return TAG.call(value);
}
export function isObject(value) {
    const t = typeof value;
    return value != null && (t === "object" || t === "function");
}
/** lodash `_isIterateeCall`: third arg is the collection when used as a `_.map` iteratee. */
export function isIterateeCall(value, index, object) {
    if (!isObject(object))
        return false;
    if (typeof index === "number") {
        if (!isArrayLike(object) || !isIndex(index))
            return false;
        if (index >= object.length)
            return false;
        const cur = object[index];
        return cur === value || (Number.isNaN(cur) && Number.isNaN(value));
    }
    if (typeof index === "string" && index in object) {
        return object[index] === value;
    }
    return false;
}
export function isLength(value) {
    return typeof value === "number" && value >= 0 && value <= MAX_SAFE && Number.isFinite(value);
}
export function isArrayLike(value) {
    if (value == null || typeof value === "function")
        return false;
    return isLength(value.length);
}
export function isArguments(value) {
    return getTag(value) === "[object Arguments]";
}
export function isTypedArray(value) {
    return /^\[object (?:Float(?:32|64)|Int(?:8|16|32)|Uint(?:8|8Clamped|16|32)|BigInt(?:64)|BigUint(?:64))Array]$/.test(getTag(value));
}
export function isBuffer(value) {
    return typeof Buffer !== "undefined" && typeof Buffer.isBuffer === "function" && Buffer.isBuffer(value);
}
export function isUnsafeKey(key) {
    return typeof key === "string" && DANGEROUS.has(key);
}
export function toKey(value) {
    if (typeof value === "symbol")
        return value;
    if (typeof value === "number") {
        if (Object.is(value, -0))
            return "-0";
        return String(value);
    }
    if (value == null)
        return String(value);
    return typeof value === "string" ? value : String(value);
}
export function isIndex(value) {
    if (typeof value === "number") {
        return Number.isInteger(value) && value >= 0 && value < MAX_SAFE;
    }
    if (typeof value === "string") {
        return UINT.test(value) && Number(value) < MAX_SAFE;
    }
    return false;
}
export function toInteger(value) {
    if (value === undefined)
        return 0;
    const n = Number(value);
    if (n === 0 || n !== n)
        return 0;
    if (n === Infinity)
        return Number.MAX_VALUE;
    if (n === -Infinity)
        return -Number.MAX_VALUE;
    return n < 0 ? Math.ceil(n) : Math.floor(n);
}
export function lodashToString(value) {
    if (value == null)
        return "";
    if (typeof value === "string")
        return value;
    if (Array.isArray(value))
        return value.map((v) => lodashToString(v)).join(",");
    if (typeof value === "symbol")
        return value.toString();
    const result = String(value);
    return result === "0" && Object.is(value, -0) ? "-0" : result;
}
function isKey(value, object) {
    if (Array.isArray(value))
        return false;
    const t = typeof value;
    if (t === "number" || t === "symbol" || t === "boolean" || value == null)
        return true;
    if (t !== "string")
        return false;
    if (!DEEP_PATH.test(value))
        return true;
    return object != null && value in Object(object);
}
export function parseStringPath(path) {
    const result = [];
    const n = path.length;
    let i = 0;
    while (i < n) {
        const ch = path[i];
        if (ch === ".") {
            if (i === 0 || path[i - 1] === "." || i === n - 1)
                result.push("");
            i++;
            continue;
        }
        if (ch === "[") {
            i++;
            const quote = path[i];
            if (quote === '"' || quote === "'") {
                i++;
                let buf = "";
                while (i < n && path[i] !== quote) {
                    if (path[i] === "\\" && i + 1 < n) {
                        buf += path[i + 1];
                        i += 2;
                        continue;
                    }
                    buf += path[i];
                    i++;
                }
                result.push(buf);
                if (i < n && path[i] === quote)
                    i++;
                if (i < n && path[i] === "]")
                    i++;
                continue;
            }
            let buf = "";
            while (i < n && path[i] !== "]") {
                buf += path[i];
                i++;
            }
            result.push(buf);
            if (i < n && path[i] === "]")
                i++;
            continue;
        }
        let buf = "";
        while (i < n && path[i] !== "." && path[i] !== "[") {
            buf += path[i];
            i++;
        }
        result.push(buf);
    }
    return result;
}
export function castPath(path, object) {
    if (Array.isArray(path))
        return path.map((p) => toKey(p));
    if (isKey(path, object))
        return [toKey(path)];
    return parseStringPath(lodashToString(path));
}
function readProp(object, key) {
    return object[key];
}
export function baseGet(object, path) {
    const segs = castPath(path, object);
    if (segs.length === 0)
        return undefined;
    let cur = object;
    for (const seg of segs) {
        if (cur == null)
            return undefined;
        cur = readProp(Object(cur), seg);
    }
    return cur;
}
export function baseHas(object, path) {
    if (object == null)
        return false;
    const segs = castPath(path, object);
    if (segs.length === 0)
        return false;
    let cur = object;
    for (const seg of segs) {
        if (cur == null)
            return false;
        const boxed = Object(cur);
        if (!Object.hasOwn(boxed, seg))
            return false;
        cur = readProp(boxed, seg);
    }
    return true;
}
function hasIn(object, path) {
    if (object == null)
        return false;
    const segs = castPath(path, object);
    if (segs.length === 0)
        return false;
    let cur = object;
    for (const seg of segs) {
        if (cur == null)
            return false;
        const boxed = Object(cur);
        if (!(seg in boxed))
            return false;
        cur = readProp(boxed, seg);
    }
    return true;
}
function assignIndexOrObject(nextKey) {
    return isIndex(nextKey) ? [] : {};
}
export function baseSet(object, path, value) {
    if (!isObject(object))
        return object;
    const segs = castPath(path, object);
    if (segs.length === 0)
        return object;
    let cur = object;
    for (let i = 0; i < segs.length; i++) {
        const key = segs[i];
        if (key === undefined)
            break;
        if (isUnsafeKey(key))
            return object;
        if (i === segs.length - 1) {
            defineData(cur, key, value);
            return object;
        }
        const nextKey = segs[i + 1];
        const existing = readProp(cur, key);
        if (!isObject(existing)) {
            defineData(cur, key, assignIndexOrObject(nextKey ?? ""));
        }
        cur = readProp(cur, key);
    }
    return object;
}
export function defineData(target, key, value) {
    if (key === "__proto__") {
        Object.defineProperty(target, key, {
            value,
            enumerable: true,
            configurable: true,
            writable: true,
        });
        return;
    }
    target[key] = value;
}
export function flattenRest(paths) {
    const out = [];
    for (const p of paths) {
        if (Array.isArray(p)) {
            for (const x of p)
                out.push(x);
        }
        else {
            out.push(p);
        }
    }
    return out;
}
export function copyEnumerable(object) {
    const result = {};
    if (isArrayLike(object) &&
        (Array.isArray(object) || isArguments(object) || isBuffer(object) || isTypedArray(object))) {
        const n = object.length;
        for (let i = 0; i < n; i++) {
            defineData(result, String(i), object[i]);
        }
        for (const key of Object.keys(object)) {
            if (!(isIndex(key) && Number(key) < n)) {
                defineData(result, key, object[key]);
            }
        }
        return result;
    }
    for (const key in object) {
        defineData(result, key, object[key]);
    }
    return result;
}
function isPlainObject(value) {
    if (value == null || typeof value !== "object" || getTag(value) !== "[object Object]")
        return false;
    const proto = Object.getPrototypeOf(value);
    if (proto === null)
        return true;
    const Ctor = Object.prototype.hasOwnProperty.call(proto, "constructor") && proto.constructor;
    return typeof Ctor === "function" && Ctor instanceof Ctor && Ctor === Object;
}
function omitClonePlain(value, seen) {
    if (!isPlainObject(value))
        return value;
    const hit = seen.get(value);
    if (hit)
        return hit;
    const out = {};
    seen.set(value, out);
    for (const key of Object.keys(value)) {
        defineData(out, key, omitClonePlain(value[key], seen));
    }
    for (const key in value) {
        if (!Object.hasOwn(value, key)) {
            defineData(out, key, omitClonePlain(value[key], seen));
        }
    }
    return out;
}
/** Walk and delete. Nested non-plain values keep identity (lodash `baseUnset`). */
export function unsetPath(object, path) {
    const segs = castPath(path, object);
    if (segs.length === 0)
        return;
    let cur = object;
    for (let i = 0; i < segs.length - 1; i++) {
        const key = segs[i];
        if (key === undefined || isUnsafeKey(key) || cur == null || !isObject(cur))
            return;
        cur = cur[key];
    }
    const last = segs[segs.length - 1];
    if (last === undefined || isUnsafeKey(last) || cur == null || !isObject(cur))
        return;
    delete cur[last];
}
export function pickPaths(object, paths) {
    const result = {};
    if (object == null)
        return result;
    for (const p of flattenRest(paths)) {
        if (hasIn(object, p))
            baseSet(result, p, baseGet(object, p));
    }
    return result;
}
export function omitPaths(object, paths) {
    if (object == null)
        return {};
    const segsList = flattenRest(paths).map((p) => castPath(p, object));
    const isDeep = segsList.some((s) => s.length > 1);
    let result = copyEnumerable(Object(object));
    if (isDeep) {
        result = omitClonePlain(result, new Map());
    }
    for (const segs of segsList)
        unsetPath(result, segs);
    return result;
}
function isJQueryLike(value) {
    return isArrayLike(value) && typeof value.splice === "function";
}
function isStringy(value) {
    return typeof value === "string" || getTag(value) === "[object String]";
}
export function isEmptyValue(value) {
    if (value == null)
        return true;
    if (isArrayLike(value) &&
        (Array.isArray(value) ||
            isStringy(value) ||
            isArguments(value) ||
            isBuffer(value) ||
            isTypedArray(value) ||
            isJQueryLike(value))) {
        return value.length === 0;
    }
    const tag = getTag(value);
    if (tag === "[object Map]" || tag === "[object Set]") {
        return value.size === 0;
    }
    return Object.keys(Object(value)).length === 0;
}
export function identityFn(value) {
    return value;
}
export function words(value) {
    const string = lodashToString(value)
        .normalize("NFD")
        .replace(/['\u2019]/g, "")
        .replace(/\p{M}+/gu, "");
    if (!string)
        return [];
    return string
        .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
        .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2")
        .replace(/(\p{L})(\p{N})/gu, "$1 $2")
        .replace(/(\p{N})(\p{L})/gu, "$1 $2")
        .replace(/[\x00-\x2f\x3a-\x40\x5b-\x60\x7b-\xbf\xac\xb1\xd7\xf7]+/g, " ")
        .replace(/[^\p{L}\p{N}\p{S}]+/gu, " ")
        .trim()
        .split(/\s+/)
        .filter(Boolean);
}
export function capitalizeWord(word) {
    const lower = word.toLowerCase();
    return lower ? lower[0].toUpperCase() + lower.slice(1) : lower;
}
function enumerableKeys(value) {
    const keys = Object.keys(value);
    const symbols = Object.getOwnPropertySymbols(value);
    for (const sym of symbols) {
        if (Object.prototype.propertyIsEnumerable.call(value, sym))
            keys.push(sym);
    }
    return keys;
}
function isBoxed(value) {
    const tag = getTag(value);
    return tag === "[object Number]" || tag === "[object String]" || tag === "[object Boolean]";
}
function unbox(value) {
    return isBoxed(value) ? value.valueOf() : value;
}
export function baseIsEqual(a, b) {
    try {
        return eq(a, b, [], []);
    }
    catch (e) {
        if (e instanceof RangeError)
            return false;
        throw e;
    }
}
function eq(a, b, stackA, stackB) {
    if (a === b)
        return true;
    if (a == null || b == null)
        return a === b;
    if (typeof a !== "object" && typeof b !== "object") {
        return a !== a && b !== b;
    }
    return deepEq(a, b, stackA, stackB);
}
function deepEq(a, b, stackA, stackB) {
    const pos = stackA.indexOf(a);
    if (pos !== -1)
        return stackB[pos] === b;
    if (isBoxed(a) || isBoxed(b))
        return eq(unbox(a), unbox(b), stackA, stackB);
    const tagA = getTag(a);
    const tagB = getTag(b);
    if (tagA !== tagB)
        return false;
    stackA.push(a);
    stackB.push(b);
    let result = false;
    switch (tagA) {
        case "[object Date]":
            result = eq(a.getTime(), b.getTime(), [], []);
            break;
        case "[object RegExp]":
            result =
                a.source === b.source &&
                    a.flags === b.flags;
            break;
        case "[object Error]": {
            const ae = a;
            const be = b;
            result = ae.name === be.name && ae.message === be.message;
            break;
        }
        case "[object Array]":
            result = equalArrays(a, b, stackA, stackB);
            break;
        case "[object Map]":
            result = equalMaps(a, b, stackA, stackB);
            break;
        case "[object Set]":
            result = equalSets(a, b, stackA, stackB);
            break;
        case "[object ArrayBuffer]":
            result = equalArrayBuffers(a, b);
            break;
        case "[object DataView]":
            result =
                a.byteLength === b.byteLength &&
                    equalArrayBuffers(a.buffer, b.buffer);
            break;
        default:
            if (isTypedArray(a)) {
                result = equalTyped(a, b);
            }
            else if (typeof a === "function" || typeof b === "function") {
                result = false;
            }
            else if (tagA === "[object Object]" || tagA === "[object Arguments]") {
                result = equalObjects(a, b, stackA, stackB);
            }
            else {
                result = false;
            }
    }
    stackA.pop();
    stackB.pop();
    return result;
}
function equalArrays(a, b, stackA, stackB) {
    if (a.length !== b.length)
        return false;
    for (let i = 0; i < a.length; i++) {
        if (!eq(a[i], b[i], stackA, stackB))
            return false;
    }
    return true;
}
function equalTyped(a, b) {
    if (a.length !== b.length)
        return false;
    for (let i = 0; i < a.length; i++) {
        const x = a[i];
        const y = b[i];
        if (x !== y && !(x !== x && y !== y))
            return false;
    }
    return true;
}
function equalArrayBuffers(a, b) {
    if (a.byteLength !== b.byteLength)
        return false;
    const va = new Uint8Array(a);
    const vb = new Uint8Array(b);
    for (let i = 0; i < va.length; i++) {
        if (va[i] !== vb[i])
            return false;
    }
    return true;
}
function equalMaps(a, b, stackA, stackB) {
    if (a.size !== b.size)
        return false;
    for (const [key, val] of a) {
        let found = false;
        for (const [ok, ov] of b) {
            if (eq(key, ok, stackA, stackB) && eq(val, ov, stackA, stackB)) {
                found = true;
                break;
            }
        }
        if (!found)
            return false;
    }
    return true;
}
function equalSets(a, b, stackA, stackB) {
    if (a.size !== b.size)
        return false;
    for (const val of a) {
        let found = false;
        for (const ov of b) {
            if (eq(val, ov, stackA, stackB)) {
                found = true;
                break;
            }
        }
        if (!found)
            return false;
    }
    return true;
}
function equalObjects(a, b, stackA, stackB) {
    const keysA = enumerableKeys(a);
    const keysB = enumerableKeys(b);
    if (keysA.length !== keysB.length)
        return false;
    for (const key of keysA) {
        if (!Object.prototype.propertyIsEnumerable.call(b, key))
            return false;
        if (!eq(a[key], b[key], stackA, stackB)) {
            return false;
        }
    }
    return true;
}
function isMatch(object, source) {
    if (object === source)
        return true;
    if (object == null || source == null || typeof source !== "object") {
        return baseIsEqual(object, source);
    }
    for (const key of Object.keys(source)) {
        const sv = source[key];
        const ov = object[key];
        if (isObject(sv) && getTag(sv) === "[object Object]") {
            if (!isMatch(ov, sv))
                return false;
        }
        else if (!baseIsEqual(ov, sv)) {
            return false;
        }
    }
    return true;
}
export function resolveIteratee(iteratee) {
    if (iteratee == null)
        return identityFn;
    if (typeof iteratee === "function")
        return iteratee;
    if (Array.isArray(iteratee)) {
        return matchesProperty(iteratee[0], iteratee[1]);
    }
    if (typeof iteratee === "object") {
        return (obj) => isMatch(obj, iteratee);
    }
    return (obj) => baseGet(obj, iteratee);
}
/** lodash `_baseMatchesProperty`: undefined matches only when the path exists. */
function matchesProperty(path, srcValue) {
    return (object) => {
        const objValue = baseGet(object, path);
        if (objValue === srcValue) {
            return objValue !== undefined || hasIn(object, path);
        }
        return baseIsEqual(srcValue, objValue);
    };
}
export function forEachCollection(collection, fn) {
    if (collection == null)
        return;
    if (isArrayLike(collection)) {
        const len = collection.length;
        for (let i = 0; i < len; i++) {
            fn(collection[i], i, collection);
        }
        return;
    }
    if (!isObject(collection))
        return;
    for (const key of Object.keys(collection)) {
        fn(collection[key], key, collection);
    }
}
export function toArrayLike(value) {
    if (value == null)
        return [];
    if (Array.isArray(value))
        return value;
    if (isArrayLike(value)) {
        const len = value.length;
        const out = new Array(len);
        for (let i = 0; i < len; i++)
            out[i] = value[i];
        return out;
    }
    return [];
}
/** lodash `_baseSlice`: copies `start..end`, densifying holes to `undefined`. */
export function baseSlice(array, start, end) {
    const len = array.length >>> 0;
    let s = start;
    let e = end;
    if (s < 0)
        s = -s > len ? 0 : len + s;
    e = e > len ? len : e;
    if (e < 0)
        e += len;
    const length = s > e ? 0 : ((e - s) >>> 0);
    s >>>= 0;
    const result = new Array(length);
    for (let i = 0; i < length; i++)
        result[i] = array[s + i];
    return result;
}
export function arrayKeys(object) {
    if (object == null)
        return [];
    const boxed = Object(object);
    if (isArrayLike(object)) {
        const n = object.length;
        const out = [];
        for (let i = 0; i < n; i++)
            out.push(String(i));
        for (const key of Object.keys(boxed)) {
            if (!(isIndex(key) && Number(key) < n))
                out.push(key);
        }
        return out;
    }
    return Object.keys(boxed);
}
export function arrayValues(object) {
    return arrayKeys(object).map((key) => Object(object)[key]);
}
function ctorOf(value, fallback) {
    const c = value.constructor;
    return typeof c === "function" ? c : fallback;
}
export function baseClone(value, deep, seen) {
    if (typeof value === "function") {
        const out = {};
        copyOwn(value, out, deep, seen);
        return out;
    }
    if (value == null || typeof value !== "object")
        return value;
    const tag = getTag(value);
    if (tag === "[object Error]" || tag === "[object WeakMap]" || tag === "[object WeakSet]") {
        return {};
    }
    let map = seen;
    if (deep) {
        if (!map)
            map = new Map();
        const hit = map.get(value);
        if (hit)
            return hit;
    }
    if (tag === "[object Date]") {
        return new Date(value.getTime());
    }
    if (tag === "[object RegExp]") {
        const src = value;
        const copy = new RegExp(src.source, src.flags);
        copy.lastIndex = src.lastIndex;
        return copy;
    }
    if (tag === "[object Boolean]" || tag === "[object Number]" || tag === "[object String]") {
        const Ctor = ctorOf(value, Object);
        return new Ctor(value.valueOf());
    }
    if (isBuffer(value)) {
        return Buffer.from(value);
    }
    if (tag === "[object ArrayBuffer]") {
        return value.slice(0);
    }
    if (tag === "[object DataView]") {
        const dv = value;
        const buf = deep ? baseClone(dv.buffer, true, map) : dv.buffer;
        return new DataView(buf, dv.byteOffset, dv.byteLength);
    }
    if (isTypedArray(value)) {
        const ta = value;
        const buf = deep ? baseClone(ta.buffer, true, map) : ta.buffer;
        return new ta.constructor(buf, ta.byteOffset, ta.length);
    }
    if (tag === "[object Map]") {
        const out = new Map();
        if (deep && map)
            map.set(value, out);
        for (const [k, v] of value) {
            out.set(deep ? baseClone(k, true, map) : k, deep ? baseClone(v, true, map) : v);
        }
        return out;
    }
    if (tag === "[object Set]") {
        const out = new Set();
        if (deep && map)
            map.set(value, out);
        for (const v of value) {
            out.add(deep ? baseClone(v, true, map) : v);
        }
        return out;
    }
    if (tag === "[object Arguments]") {
        const out = {};
        if (deep && map)
            map.set(value, out);
        copyOwn(value, out, deep, map);
        return out;
    }
    if (Array.isArray(value)) {
        const out = new Array(value.length);
        if (deep && map)
            map.set(value, out);
        for (let i = 0; i < value.length; i++) {
            out[i] = deep ? baseClone(value[i], true, map) : value[i];
        }
        for (const key of Object.keys(value)) {
            if (!isIndex(key)) {
                const rec = value;
                defineData(out, key, deep ? baseClone(rec[key], true, map) : rec[key]);
            }
        }
        return out;
    }
    const proto = Object.getPrototypeOf(value);
    const out = Object.create(proto);
    if (deep && map)
        map.set(value, out);
    copyOwn(value, out, deep, map);
    return out;
}
function copyOwn(source, target, deep, seen) {
    for (const key of enumerableKeys(source)) {
        const val = source[key];
        defineData(target, key, deep ? baseClone(val, true, seen) : val);
    }
}
//# sourceMappingURL=_internal.js.map