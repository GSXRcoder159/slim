/**
 * Deep clone of call arguments so orig and slim cannot share mutable state.
 * Functions are returned by reference (not cloned). Cycles use WeakMap.
 */
export function clone<T>(value: T, seen: WeakMap<object, unknown> = new WeakMap()): T {
  if (value === null || typeof value !== "object") return value;
  if (typeof value === "function") return value;

  const obj = value as object;
  const cached = seen.get(obj);
  if (cached !== undefined) return cached as T;

  if (value instanceof Date) {
    const c = new Date(value.getTime());
    seen.set(obj, c);
    return c as T;
  }

  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
    const c = Buffer.from(value);
    seen.set(obj, c);
    return c as T;
  }

  if (value instanceof ArrayBuffer) {
    const c = value.slice(0);
    seen.set(obj, c);
    return c as T;
  }

  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    const Ctor = value.constructor as new (src: ArrayBufferView) => ArrayBufferView;
    const c = new Ctor(value);
    seen.set(obj, c);
    return c as T;
  }

  if (value instanceof DataView) {
    const buf = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    const c = new DataView(buf);
    seen.set(obj, c);
    return c as T;
  }

  if (value instanceof Map) {
    const c = new Map();
    seen.set(obj, c);
    for (const [k, v] of value) c.set(clone(k, seen), clone(v, seen));
    return c as T;
  }

  if (value instanceof Set) {
    const c = new Set();
    seen.set(obj, c);
    for (const v of value) c.add(clone(v, seen));
    return c as T;
  }

  if (value instanceof Error) {
    const Ctor = value.constructor as new (message?: string) => Error;
    const c = new Ctor(value.message);
    seen.set(obj, c);
    c.name = value.name;
    c.stack = value.stack;
    if ("code" in value) {
      (c as Error & { code?: unknown }).code = (value as Error & { code?: unknown }).code;
    }
    if ("cause" in value) {
      (c as Error & { cause?: unknown }).cause = clone(
        (value as Error & { cause?: unknown }).cause,
        seen,
      );
    }
    return c as T;
  }

  if (value instanceof RegExp) {
    const c = new RegExp(value.source, value.flags);
    seen.set(obj, c);
    return c as T;
  }

  if (Array.isArray(value)) {
    const c: unknown[] = new Array(value.length);
    seen.set(obj, c);
    for (let i = 0; i < value.length; i++) {
      if (i in value) c[i] = clone(value[i], seen);
    }
    return c as T;
  }

  const proto = Object.getPrototypeOf(value);
  const c = Object.create(proto);
  seen.set(obj, c);
  for (const key of Reflect.ownKeys(value)) {
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (!desc) continue;
    if (desc.value !== undefined || "value" in desc) {
      Object.defineProperty(c, key, {
        ...desc,
        value: typeof desc.value === "function" ? desc.value : clone(desc.value, seen),
      });
    } else {
      Object.defineProperty(c, key, desc);
    }
  }
  return c as T;
}
