import type { HyrumFlags } from "../envelope/types.ts";
import { clone } from "./clone.ts";

export interface EqualOptions {
  /** When true, -0 and +0 are not equal (Object.is). Default SameValueZero. */
  signedZero?: boolean;
  /** When true, enumerable key insertion order must match. */
  keyOrder?: boolean;
}

export type CallOutcome =
  | { ok: true; value: unknown; argsAfter: unknown[] }
  | {
      ok: false;
      error: { name: string; message: string; code?: unknown };
      argsAfter: unknown[];
    };

export function normalizeError(e: unknown): {
  name: string;
  message: string;
  code?: unknown;
} {
  if (e instanceof Error) {
    const code = (e as Error & { code?: unknown }).code;
    return { name: e.name, message: e.message, ...(code !== undefined ? { code } : {}) };
  }
  return { name: "Error", message: String(e) };
}

/** Clone args and receiver, call `fn`, capture return/throw and post-call arg state. */
export function invoke(
  fn: Function,
  args: unknown[],
  thisArg?: unknown,
): CallOutcome {
  const cloned = args.map((a) => clone(a));
  const clonedThis =
    thisArg === undefined || thisArg === null ? thisArg : clone(thisArg);
  try {
    const value = fn.apply(clonedThis, cloned);
    return { ok: true, value, argsAfter: cloned };
  } catch (e) {
    return { ok: false, error: normalizeError(e), argsAfter: cloned };
  }
}

export function equalThrown(
  a: { name: string; message: string; code?: unknown },
  b: { name: string; message: string; code?: unknown },
): boolean {
  return a.name === b.name && a.message === b.message && Object.is(a.code, b.code);
}

export function equal(
  a: unknown,
  b: unknown,
  hyrum?: Partial<HyrumFlags>,
  options?: EqualOptions,
): boolean {
  const signedZero = options?.signedZero === true || hyrum?.signedZero === true;
  const keyOrder = options?.keyOrder === true || hyrum?.keyOrder === true;
  return eq(a, b, signedZero, keyOrder, new WeakMap());
}

export function equalResults(
  orig: CallOutcome,
  slim: CallOutcome,
  hyrum?: Partial<HyrumFlags>,
  options?: EqualOptions,
): { ok: boolean; reason?: string } {
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
    if (!equalThrown(orig.error, slim.error)) {
      return {
        ok: false,
        reason: `error mismatch: ${orig.error.name}:${orig.error.message} vs ${slim.error.name}:${slim.error.message}`,
      };
    }
  } else if (orig.ok && slim.ok) {
    if (!equal(orig.value, slim.value, hyrum, options)) {
      return { ok: false, reason: "return value mismatch" };
    }
  }
  if (orig.argsAfter.length !== slim.argsAfter.length) {
    return {
      ok: false,
      reason: `argument mutation mismatch: argc ${orig.argsAfter.length} vs ${slim.argsAfter.length}`,
    };
  }
  for (let i = 0; i < orig.argsAfter.length; i++) {
    if (!equal(orig.argsAfter[i], slim.argsAfter[i], hyrum, options)) {
      return { ok: false, reason: `argument mutation mismatch at index ${i}` };
    }
  }
  return { ok: true };
}

function eq(
  a: unknown,
  b: unknown,
  signedZero: boolean,
  keyOrder: boolean,
  seen: WeakMap<object, object>,
): boolean {
  if (sameValueZero(a, b, signedZero)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a === "function" && typeof b === "function") {
    if (a === b) return true;
    return a.name === b.name && a.length === b.length;
  }
  if (typeof a !== "object" || typeof b !== "object") return false;

  const ao = a as object;
  const bo = b as object;
  const prev = seen.get(ao);
  if (prev) return prev === bo;
  seen.set(ao, bo);

  if (a instanceof Date && b instanceof Date) {
    const at = a.getTime();
    const bt = b.getTime();
    if (Number.isNaN(at) && Number.isNaN(bt)) return true;
    return at === bt;
  }
  if (a instanceof Date || b instanceof Date) return false;

  if (a instanceof RegExp && b instanceof RegExp) {
    return a.source === b.source && a.flags === b.flags;
  }

  if (typeof Buffer !== "undefined" && Buffer.isBuffer(a) && Buffer.isBuffer(b)) {
    return a.equals(b);
  }

  if (a instanceof ArrayBuffer && b instanceof ArrayBuffer) {
    if (a.byteLength !== b.byteLength) return false;
    return eq(new Uint8Array(a), new Uint8Array(b), signedZero, keyOrder, seen);
  }

  if (ArrayBuffer.isView(a) && ArrayBuffer.isView(b)) {
    if (a.byteLength !== b.byteLength) return false;
    const ua = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const ub = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return false;
    return true;
  }

  if (a instanceof Error && b instanceof Error) {
    const ac = (a as Error & { code?: unknown }).code;
    const bc = (b as Error & { code?: unknown }).code;
    return equalThrown(
      { name: a.name, message: a.message, code: ac },
      { name: b.name, message: b.message, code: bc },
    );
  }

  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    const ae = [...a.entries()];
    const be = [...b.entries()];
    for (let i = 0; i < ae.length; i++) {
      const av = ae[i]!;
      const bv = be[i]!;
      if (!eq(av[0], bv[0], signedZero, keyOrder, seen)) return false;
      if (!eq(av[1], bv[1], signedZero, keyOrder, seen)) return false;
    }
    return true;
  }
  if (a instanceof Map || b instanceof Map) return false;

  if (a instanceof Set && b instanceof Set) {
    if (a.size !== b.size) return false;
    const unused = [...b];
    for (const av of a) {
      const idx = unused.findIndex((bv) => eq(av, bv, signedZero, keyOrder, seen));
      if (idx < 0) return false;
      unused.splice(idx, 1);
    }
    return true;
  }
  if (a instanceof Set || b instanceof Set) return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      const ha = i in a;
      const hb = i in b;
      if (ha !== hb) return false;
      if (ha && !eq(a[i], b[i], signedZero, keyOrder, seen)) return false;
    }
    return true;
  }

  const aKeys = Reflect.ownKeys(a).filter((k) => enumerableOwn(a, k));
  const bKeys = Reflect.ownKeys(b).filter((k) => enumerableOwn(b, k));
  if (aKeys.length !== bKeys.length) return false;
  if (keyOrder) {
    for (let i = 0; i < aKeys.length; i++) {
      if (aKeys[i] !== bKeys[i]) return false;
    }
    for (let i = 0; i < aKeys.length; i++) {
      const k = aKeys[i]!;
      if (!eq((a as Record<PropertyKey, unknown>)[k], (b as Record<PropertyKey, unknown>)[k], signedZero, keyOrder, seen)) {
        return false;
      }
    }
    return true;
  }
  const bSet = new Set(bKeys);
  for (const k of aKeys) {
    if (!bSet.has(k)) return false;
    if (!eq((a as Record<PropertyKey, unknown>)[k], (b as Record<PropertyKey, unknown>)[k], signedZero, keyOrder, seen)) {
      return false;
    }
  }
  return true;
}

function enumerableOwn(obj: object, key: PropertyKey): boolean {
  const d = Object.getOwnPropertyDescriptor(obj, key);
  return d?.enumerable === true;
}

function sameValueZero(a: unknown, b: unknown, signedZero: boolean): boolean {
  if (typeof a === "number" && typeof b === "number") {
    if (Number.isNaN(a) && Number.isNaN(b)) return true;
    if (signedZero) return Object.is(a, b);
    return a === b;
  }
  return a === b;
}
