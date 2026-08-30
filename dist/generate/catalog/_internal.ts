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

export function getTag(value: unknown): string {
  return TAG.call(value);
}

export function isObject(value: unknown): value is object {
  const t = typeof value;
  return value != null && (t === "object" || t === "function");
}

/** lodash `_isIterateeCall`: third arg is the collection when used as a `_.map` iteratee. */
export function isIterateeCall(value: unknown, index: unknown, object: unknown): boolean {
  if (!isObject(object)) return false;
  if (typeof index === "number") {
    if (!isArrayLike(object) || !isIndex(index)) return false;
    if (index >= (object as ArrayLike<unknown>).length) return false;
    const cur = (object as ArrayLike<unknown>)[index];
    return cur === value || (Number.isNaN(cur as number) && Number.isNaN(value as number));
  }
  if (typeof index === "string" && index in object) {
    return (object as Record<string, unknown>)[index] === value;
  }
  return false;
}

export function isLength(value: unknown): value is number {
  return typeof value === "number" && value >= 0 && value <= MAX_SAFE && Number.isFinite(value);
}

export function isArrayLike(value: unknown): boolean {
  if (value == null || typeof value === "function") return false;
  return isLength((value as { length?: unknown }).length);
}

export function isArguments(value: unknown): boolean {
  return getTag(value) === "[object Arguments]";
}

export function isTypedArray(value: unknown): boolean {
  return /^\[object (?:Float(?:32|64)|Int(?:8|16|32)|Uint(?:8|8Clamped|16|32)|BigInt(?:64)|BigUint(?:64))Array]$/.test(
    getTag(value),
  );
}

export function isBuffer(value: unknown): boolean {
  return typeof Buffer !== "undefined" && typeof Buffer.isBuffer === "function" && Buffer.isBuffer(value);
}

export function isUnsafeKey(key: PropertyKey): boolean {
  return typeof key === "string" && DANGEROUS.has(key);
}

export function toKey(value: unknown): PropertyKey {
  if (typeof value === "symbol") return value;
  if (typeof value === "number") {
    if (Object.is(value, -0)) return "-0";
    return String(value);
  }
  if (value == null) return String(value);
  return typeof value === "string" ? value : String(value);
}

export function isIndex(value: unknown): boolean {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 && value < MAX_SAFE;
  }
  if (typeof value === "string") {
    return UINT.test(value) && Number(value) < MAX_SAFE;
  }
  return false;
}

export function toInteger(value: unknown): number {
  if (value === undefined) return 0;
  const n = Number(value);
  if (n === 0 || n !== n) return 0;
  if (n === Infinity) return Number.MAX_VALUE;
  if (n === -Infinity) return -Number.MAX_VALUE;
  return n < 0 ? Math.ceil(n) : Math.floor(n);
}

export function lodashToString(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((v) => lodashToString(v)).join(",");
  if (typeof value === "symbol") return value.toString();
  const result = String(value);
  return result === "0" && Object.is(value, -0) ? "-0" : result;
}

function isKey(value: unknown, object?: unknown): boolean {
  if (Array.isArray(value)) return false;
  const t = typeof value;
  if (t === "number" || t === "symbol" || t === "boolean" || value == null) return true;
  if (t !== "string") return false;
  if (!DEEP_PATH.test(value as string)) return true;
  return object != null && (value as string) in Object(object);
}

export function parseStringPath(path: string): string[] {
  const result: string[] = [];
  const n = path.length;
  let i = 0;
  while (i < n) {
    const ch = path[i];
    if (ch === ".") {
      if (i === 0 || path[i - 1] === "." || i === n - 1) result.push("");
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
        if (i < n && path[i] === quote) i++;
        if (i < n && path[i] === "]") i++;
        continue;
      }
      let buf = "";
      while (i < n && path[i] !== "]") {
        buf += path[i];
        i++;
      }
      result.push(buf);
      if (i < n && path[i] === "]") i++;
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

export function castPath(path: unknown, object?: unknown): PropertyKey[] {
  if (Array.isArray(path)) return path.map((p) => toKey(p));
  if (isKey(path, object)) return [toKey(path)];
  return parseStringPath(lodashToString(path));
}

function readProp(object: object, key: PropertyKey): unknown {
  return (object as Record<PropertyKey, unknown>)[key];
}

export function baseGet(object: unknown, path: unknown): unknown {
  const segs = castPath(path, object);
  if (segs.length === 0) return undefined;
  let cur: unknown = object;
  for (const seg of segs) {
    if (cur == null) return undefined;
    cur = readProp(Object(cur) as object, seg);
  }
  return cur;
}

export function baseHas(object: unknown, path: unknown): boolean {
  if (object == null) return false;
  const segs = castPath(path, object);
  if (segs.length === 0) return false;
  let cur: unknown = object;
  for (const seg of segs) {
    if (cur == null) return false;
    const boxed = Object(cur) as object;
    if (!Object.hasOwn(boxed, seg)) return false;
    cur = readProp(boxed, seg);
  }
  return true;
}

function hasIn(object: unknown, path: unknown): boolean {
  if (object == null) return false;
  const segs = castPath(path, object);
  if (segs.length === 0) return false;
  let cur: unknown = object;
  for (const seg of segs) {
    if (cur == null) return false;
    const boxed = Object(cur) as object;
    if (!(seg in boxed)) return false;
    cur = readProp(boxed, seg);
  }
  return true;
}

function assignIndexOrObject(nextKey: PropertyKey): object {
  return isIndex(nextKey) ? [] : {};
}

export function baseSet(object: unknown, path: unknown, value: unknown): unknown {
  if (!isObject(object)) return object;
  const segs = castPath(path, object);
  if (segs.length === 0) return object;
  let cur: object = object;
  for (let i = 0; i < segs.length; i++) {
    const key = segs[i];
    if (key === undefined) break;
    if (isUnsafeKey(key)) return object;
    if (i === segs.length - 1) {
      defineData(cur, key, value);
      return object;
    }
    const nextKey = segs[i + 1];
    const existing = readProp(cur, key);
    if (!isObject(existing)) {
      defineData(cur, key, assignIndexOrObject(nextKey ?? ""));
    }
    cur = readProp(cur, key) as object;
  }
  return object;
}

export function defineData(target: object, key: PropertyKey, value: unknown): void {
  if (key === "__proto__") {
    Object.defineProperty(target, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    return;
  }
  (target as Record<PropertyKey, unknown>)[key] = value;
}

export function flattenRest(paths: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const p of paths) {
    if (Array.isArray(p)) {
      for (const x of p) out.push(x);
    } else {
      out.push(p);
    }
  }
  return out;
}

export function copyEnumerable(object: object): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (
    isArrayLike(object) &&
    (Array.isArray(object) || isArguments(object) || isBuffer(object) || isTypedArray(object))
  ) {
    const n = (object as ArrayLike<unknown>).length;
    for (let i = 0; i < n; i++) {
      defineData(result, String(i), (object as ArrayLike<unknown>)[i]);
    }
    for (const key of Object.keys(object)) {
      if (!(isIndex(key) && Number(key) < n)) {
        defineData(result, key, (object as Record<string, unknown>)[key]);
      }
    }
    return result;
  }
  for (const key in object) {
    defineData(result, key, (object as Record<string, unknown>)[key]);
  }
  return result;
}

function isPlainObject(value: unknown): boolean {
  if (value == null || typeof value !== "object" || getTag(value) !== "[object Object]") return false;
  const proto = Object.getPrototypeOf(value);
  if (proto === null) return true;
  const Ctor = Object.prototype.hasOwnProperty.call(proto, "constructor") && proto.constructor;
  return typeof Ctor === "function" && Ctor instanceof Ctor && Ctor === Object;
}

function omitClonePlain(value: unknown, seen: Map<object, Record<PropertyKey, unknown>>): unknown {
  if (!isPlainObject(value)) return value;
  const hit = seen.get(value as object);
  if (hit) return hit;
  const out: Record<PropertyKey, unknown> = {};
  seen.set(value as object, out);
  for (const key of Object.keys(value as object)) {
    defineData(out, key, omitClonePlain((value as Record<string, unknown>)[key], seen));
  }
  for (const key in value as object) {
    if (!Object.hasOwn(value as object, key)) {
      defineData(out, key, omitClonePlain((value as Record<string, unknown>)[key], seen));
    }
  }
  return out;
}

/** Walk and delete. Nested non-plain values keep identity (lodash `baseUnset`). */
export function unsetPath(object: Record<string, unknown>, path: unknown): void {
  const segs = castPath(path, object);
  if (segs.length === 0) return;
  let cur: Record<PropertyKey, unknown> | undefined = object;
  for (let i = 0; i < segs.length - 1; i++) {
    const key = segs[i];
    if (key === undefined || isUnsafeKey(key) || cur == null || !isObject(cur)) return;
    cur = cur[key] as Record<PropertyKey, unknown>;
  }
  const last = segs[segs.length - 1];
  if (last === undefined || isUnsafeKey(last) || cur == null || !isObject(cur)) return;
  delete cur[last];
}

export function pickPaths(object: unknown, paths: unknown[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (object == null) return result;
  for (const p of flattenRest(paths)) {
    if (hasIn(object, p)) baseSet(result, p, baseGet(object, p));
  }
  return result;
}

export function omitPaths(object: unknown, paths: unknown[]): Record<string, unknown> {
  if (object == null) return {};
  const segsList = flattenRest(paths).map((p) => castPath(p, object));
  const isDeep = segsList.some((s) => s.length > 1);
  let result: Record<string, unknown> = copyEnumerable(Object(object) as object);
  if (isDeep) {
    result = omitClonePlain(result, new Map()) as Record<string, unknown>;
  }
  for (const segs of segsList) unsetPath(result, segs);
  return result;
}

function isJQueryLike(value: unknown): boolean {
  return isArrayLike(value) && typeof (value as { splice?: unknown }).splice === "function";
}

function isStringy(value: unknown): boolean {
  return typeof value === "string" || getTag(value) === "[object String]";
}

export function isEmptyValue(value: unknown): boolean {
  if (value == null) return true;
  if (
    isArrayLike(value) &&
    (Array.isArray(value) ||
      isStringy(value) ||
      isArguments(value) ||
      isBuffer(value) ||
      isTypedArray(value) ||
      isJQueryLike(value))
  ) {
    return (value as { length: number }).length === 0;
  }
  const tag = getTag(value);
  if (tag === "[object Map]" || tag === "[object Set]") {
    return (value as Map<unknown, unknown> | Set<unknown>).size === 0;
  }
  return Object.keys(Object(value)).length === 0;
}

export function identityFn<T>(value: T): T {
  return value;
}

export function words(value: unknown): string[] {
  const string = lodashToString(value)
    .normalize("NFD")
    .replace(/['\u2019]/g, "")
    .replace(/\p{M}+/gu, "");
  if (!string) return [];
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

export function capitalizeWord(word: string): string {
  const lower = word.toLowerCase();
  return lower ? lower[0]!.toUpperCase() + lower.slice(1) : lower;
}

function enumerableKeys(value: object): PropertyKey[] {
  const keys: PropertyKey[] = Object.keys(value);
  const symbols = Object.getOwnPropertySymbols(value);
  for (const sym of symbols) {
    if (Object.prototype.propertyIsEnumerable.call(value, sym)) keys.push(sym);
  }
  return keys;
}

function isBoxed(value: unknown): boolean {
  const tag = getTag(value);
  return tag === "[object Number]" || tag === "[object String]" || tag === "[object Boolean]";
}

function unbox(value: unknown): unknown {
  return isBoxed(value) ? (value as { valueOf: () => unknown }).valueOf() : value;
}

export function baseIsEqual(a: unknown, b: unknown): boolean {
  try {
    return eq(a, b, [], []);
  } catch (e) {
    if (e instanceof RangeError) return false;
    throw e;
  }
}

function eq(a: unknown, b: unknown, stackA: unknown[], stackB: unknown[]): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== "object" && typeof b !== "object") {
    return a !== a && b !== b;
  }
  return deepEq(a, b, stackA, stackB);
}

function deepEq(a: unknown, b: unknown, stackA: unknown[], stackB: unknown[]): boolean {
  const pos = stackA.indexOf(a);
  if (pos !== -1) return stackB[pos] === b;
  if (isBoxed(a) || isBoxed(b)) return eq(unbox(a), unbox(b), stackA, stackB);

  const tagA = getTag(a);
  const tagB = getTag(b);
  if (tagA !== tagB) return false;

  stackA.push(a);
  stackB.push(b);

  let result = false;
  switch (tagA) {
    case "[object Date]":
      result = eq((a as Date).getTime(), (b as Date).getTime(), [], []);
      break;
    case "[object RegExp]":
      result =
        (a as RegExp).source === (b as RegExp).source &&
        (a as RegExp).flags === (b as RegExp).flags;
      break;
    case "[object Error]": {
      const ae = a as Error;
      const be = b as Error;
      result = ae.name === be.name && ae.message === be.message;
      break;
    }
    case "[object Array]":
      result = equalArrays(a as unknown[], b as unknown[], stackA, stackB);
      break;
    case "[object Map]":
      result = equalMaps(a as Map<unknown, unknown>, b as Map<unknown, unknown>, stackA, stackB);
      break;
    case "[object Set]":
      result = equalSets(a as Set<unknown>, b as Set<unknown>, stackA, stackB);
      break;
    case "[object ArrayBuffer]":
      result = equalArrayBuffers(a as ArrayBuffer, b as ArrayBuffer);
      break;
    case "[object DataView]":
      result =
        (a as DataView).byteLength === (b as DataView).byteLength &&
        equalArrayBuffers((a as DataView).buffer as ArrayBuffer, (b as DataView).buffer as ArrayBuffer);
      break;
    default:
      if (isTypedArray(a)) {
        result = equalTyped(a as ArrayLike<unknown>, b as ArrayLike<unknown>);
      } else if (typeof a === "function" || typeof b === "function") {
        result = false;
      } else if (tagA === "[object Object]" || tagA === "[object Arguments]") {
        result = equalObjects(a as object, b as object, stackA, stackB);
      } else {
        result = false;
      }
  }

  stackA.pop();
  stackB.pop();
  return result;
}

function equalArrays(a: unknown[], b: unknown[], stackA: unknown[], stackB: unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!eq(a[i], b[i], stackA, stackB)) return false;
  }
  return true;
}

function equalTyped(a: ArrayLike<unknown>, b: ArrayLike<unknown>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x !== y && !(x !== x && y !== y)) return false;
  }
  return true;
}

function equalArrayBuffers(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const va = new Uint8Array(a);
  const vb = new Uint8Array(b);
  for (let i = 0; i < va.length; i++) {
    if (va[i] !== vb[i]) return false;
  }
  return true;
}

function equalMaps(
  a: Map<unknown, unknown>,
  b: Map<unknown, unknown>,
  stackA: unknown[],
  stackB: unknown[],
): boolean {
  if (a.size !== b.size) return false;
  for (const [key, val] of a) {
    let found = false;
    for (const [ok, ov] of b) {
      if (eq(key, ok, stackA, stackB) && eq(val, ov, stackA, stackB)) {
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

function equalSets(a: Set<unknown>, b: Set<unknown>, stackA: unknown[], stackB: unknown[]): boolean {
  if (a.size !== b.size) return false;
  for (const val of a) {
    let found = false;
    for (const ov of b) {
      if (eq(val, ov, stackA, stackB)) {
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

function equalObjects(a: object, b: object, stackA: unknown[], stackB: unknown[]): boolean {
  const keysA = enumerableKeys(a);
  const keysB = enumerableKeys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!Object.prototype.propertyIsEnumerable.call(b, key)) return false;
    if (!eq((a as Record<PropertyKey, unknown>)[key], (b as Record<PropertyKey, unknown>)[key], stackA, stackB)) {
      return false;
    }
  }
  return true;
}

function isMatch(object: unknown, source: unknown): boolean {
  if (object === source) return true;
  if (object == null || source == null || typeof source !== "object") {
    return baseIsEqual(object, source);
  }
  for (const key of Object.keys(source as object)) {
    const sv = (source as Record<string, unknown>)[key];
    const ov = (object as Record<string, unknown>)[key];
    if (isObject(sv) && getTag(sv) === "[object Object]") {
      if (!isMatch(ov, sv)) return false;
    } else if (!baseIsEqual(ov, sv)) {
      return false;
    }
  }
  return true;
}

export type Iteratee = (value: unknown, key: unknown, collection: unknown) => unknown;

export function resolveIteratee(iteratee?: unknown): Iteratee {
  if (iteratee == null) return identityFn;
  if (typeof iteratee === "function") return iteratee as Iteratee;
  if (Array.isArray(iteratee)) {
    return matchesProperty(iteratee[0], iteratee[1]);
  }
  if (typeof iteratee === "object") {
    return (obj) => isMatch(obj, iteratee);
  }
  return (obj) => baseGet(obj, iteratee);
}

/** lodash `_baseMatchesProperty`: undefined matches only when the path exists. */
function matchesProperty(path: unknown, srcValue: unknown): Iteratee {
  return (object) => {
    const objValue = baseGet(object, path);
    if (objValue === srcValue) {
      return objValue !== undefined || hasIn(object, path);
    }
    return baseIsEqual(srcValue, objValue);
  };
}

export function forEachCollection(
  collection: unknown,
  fn: (value: unknown, key: PropertyKey, collection: unknown) => void,
): void {
  if (collection == null) return;
  if (isArrayLike(collection)) {
    const len = (collection as ArrayLike<unknown>).length;
    for (let i = 0; i < len; i++) {
      fn((collection as ArrayLike<unknown>)[i], i, collection);
    }
    return;
  }
  if (!isObject(collection)) return;
  for (const key of Object.keys(collection)) {
    fn((collection as Record<string, unknown>)[key], key, collection);
  }
}

export function toArrayLike(value: unknown): unknown[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  if (isArrayLike(value)) {
    const len = (value as ArrayLike<unknown>).length;
    const out: unknown[] = new Array(len);
    for (let i = 0; i < len; i++) out[i] = (value as ArrayLike<unknown>)[i];
    return out;
  }
  return [];
}

/** lodash `_baseSlice`: copies `start..end`, densifying holes to `undefined`. */
export function baseSlice(array: ArrayLike<unknown>, start: number, end: number): unknown[] {
  const len = array.length >>> 0;
  let s = start;
  let e = end;
  if (s < 0) s = -s > len ? 0 : len + s;
  e = e > len ? len : e;
  if (e < 0) e += len;
  const length = s > e ? 0 : ((e - s) >>> 0);
  s >>>= 0;
  const result: unknown[] = new Array(length);
  for (let i = 0; i < length; i++) result[i] = array[s + i];
  return result;
}

export function arrayKeys(object: unknown): string[] {
  if (object == null) return [];
  const boxed = Object(object) as object;
  if (isArrayLike(object)) {
    const n = (object as ArrayLike<unknown>).length;
    const out: string[] = [];
    for (let i = 0; i < n; i++) out.push(String(i));
    for (const key of Object.keys(boxed)) {
      if (!(isIndex(key) && Number(key) < n)) out.push(key);
    }
    return out;
  }
  return Object.keys(boxed);
}

export function arrayValues(object: unknown): unknown[] {
  return arrayKeys(object).map((key) => (Object(object) as Record<string, unknown>)[key]);
}

function ctorOf<T>(value: T, fallback: new (...args: never[]) => T): new (...args: never[]) => T {
  const c = (value as { constructor?: unknown }).constructor;
  return typeof c === "function" ? (c as new (...args: never[]) => T) : fallback;
}

export function baseClone(value: unknown, deep: boolean, seen?: Map<object, unknown>): unknown {
  if (typeof value === "function") {
    const out: Record<string, unknown> = {};
    copyOwn(value as object, out, deep, seen);
    return out;
  }
  if (value == null || typeof value !== "object") return value;

  const tag = getTag(value);
  if (tag === "[object Error]" || tag === "[object WeakMap]" || tag === "[object WeakSet]") {
    return {};
  }

  let map = seen;
  if (deep) {
    if (!map) map = new Map();
    const hit = map.get(value);
    if (hit) return hit;
  }

  if (tag === "[object Date]") {
    return new Date((value as Date).getTime());
  }
  if (tag === "[object RegExp]") {
    const src = value as RegExp;
    const copy = new RegExp(src.source, src.flags);
    copy.lastIndex = src.lastIndex;
    return copy;
  }
  if (tag === "[object Boolean]" || tag === "[object Number]" || tag === "[object String]") {
    const Ctor = ctorOf(value as never, Object as never);
    return new (Ctor as unknown as new (v: unknown) => object)((value as { valueOf: () => unknown }).valueOf());
  }
  if (isBuffer(value)) {
    return Buffer.from(value as Buffer);
  }
  if (tag === "[object ArrayBuffer]") {
    return (value as ArrayBuffer).slice(0);
  }
  if (tag === "[object DataView]") {
    const dv = value as DataView;
    const buf = deep ? (baseClone(dv.buffer, true, map) as ArrayBuffer) : dv.buffer;
    return new DataView(buf, dv.byteOffset, dv.byteLength);
  }
  if (isTypedArray(value)) {
    const ta = value as unknown as { constructor: new (a: ArrayBufferLike, b?: number, c?: number) => unknown; buffer: ArrayBuffer; byteOffset: number; length: number };
    const buf = deep ? (baseClone(ta.buffer, true, map) as ArrayBuffer) : ta.buffer;
    return new ta.constructor(buf, ta.byteOffset, ta.length);
  }
  if (tag === "[object Map]") {
    const out = new Map();
    if (deep && map) map.set(value, out);
    for (const [k, v] of value as Map<unknown, unknown>) {
      out.set(deep ? baseClone(k, true, map) : k, deep ? baseClone(v, true, map) : v);
    }
    return out;
  }
  if (tag === "[object Set]") {
    const out = new Set();
    if (deep && map) map.set(value, out);
    for (const v of value as Set<unknown>) {
      out.add(deep ? baseClone(v, true, map) : v);
    }
    return out;
  }
  if (tag === "[object Arguments]") {
    const out: Record<string, unknown> = {};
    if (deep && map) map.set(value, out);
    copyOwn(value as object, out, deep, map);
    return out;
  }
  if (Array.isArray(value)) {
    const out: unknown[] = new Array(value.length);
    if (deep && map) map.set(value, out);
    for (let i = 0; i < value.length; i++) {
      out[i] = deep ? baseClone(value[i], true, map) : value[i];
    }
    for (const key of Object.keys(value)) {
      if (!isIndex(key)) {
        const rec = value as unknown as Record<string, unknown>;
        defineData(out, key, deep ? baseClone(rec[key], true, map) : rec[key]);
      }
    }
    return out;
  }

  const proto = Object.getPrototypeOf(value);
  const out = Object.create(proto);
  if (deep && map) map.set(value, out);
  copyOwn(value as object, out, deep, map);
  return out;
}

function copyOwn(source: object, target: object, deep: boolean, seen?: Map<object, unknown>): void {
  for (const key of enumerableKeys(source)) {
    const val = (source as Record<PropertyKey, unknown>)[key];
    defineData(target, key, deep ? baseClone(val, true, seen) : val);
  }
}
