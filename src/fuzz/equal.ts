import type { HyrumFlags } from "../envelope/types.ts";
import { cloneInvocation } from "./clone.ts";

export interface EqualOptions {
  /** When true, -0 and +0 are not equal (Object.is). Default SameValueZero. */
  signedZero?: boolean;
  /** When true, enumerable key insertion order must match. */
  keyOrder?: boolean;
}

export type CallOutcome =
  | { ok: true; value: unknown; argsAfter: unknown[]; thisAfter?: unknown }
  | {
      ok: false;
      error: { name: string; message: string; code?: unknown };
      argsAfter: unknown[];
      thisAfter?: unknown;
    };

interface EqCtx {
  signedZero: boolean;
  keyOrder: boolean;
  prototype: boolean;
  nan: boolean;
  sparseArray: boolean;
  toString: boolean;
  json: boolean;
  dateIdentity: boolean;
  sameReference: boolean;
  mutation: boolean;
  errorMessage: boolean;
}

function ctxOf(hyrum?: Partial<HyrumFlags>, options?: EqualOptions): EqCtx {
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

/** Clone args and receiver, call `fn`, capture return/throw and post-call arg/this state. */
export function invoke(
  fn: Function,
  args: unknown[],
  thisArg?: unknown,
): CallOutcome {
  const { args: cloned, thisArg: clonedThis } = cloneInvocation(args, thisArg);
  try {
    const value = fn.apply(clonedThis, cloned);
    return { ok: true, value, argsAfter: cloned, thisAfter: clonedThis };
  } catch (e) {
    if (needsNew(e)) {
      try {
        const value = Reflect.construct(fn, cloned);
        return { ok: true, value, argsAfter: cloned, thisAfter: clonedThis };
      } catch (e2) {
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

function needsNew(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /without ['"]?new['"]?/i.test(msg) || /Class constructor/i.test(msg);
}

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return Boolean(v && (typeof v === "object" || typeof v === "function") && typeof (v as { then?: unknown }).then === "function");
}

/** Await thenable return values so Promise-returning APIs compare by settlement. */
export async function settleOutcome(out: CallOutcome, timeoutMs = 2000): Promise<CallOutcome> {
  if (!out.ok || !isThenable(out.value)) return out;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      Promise.resolve(out.value),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("thenable timeout")), timeoutMs);
      }),
    ]);
    return { ok: true, value, argsAfter: out.argsAfter, thisAfter: out.thisAfter };
  } catch (e) {
    return {
      ok: false,
      error: normalizeError(e),
      argsAfter: out.argsAfter,
      thisAfter: out.thisAfter,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function equalThrown(
  a: { name: string; message: string; code?: unknown },
  b: { name: string; message: string; code?: unknown },
  hyrum?: Partial<HyrumFlags>,
): boolean {
  if (a.name !== b.name) return false;
  /* errorMessage is always-on substitution: name+message+code. Flag records observation. */
  void hyrum?.errorMessage;
  if (invalidUrlTypeError(a, b)) return true;
  return a.message === b.message && Object.is(a.code, b.code);
}

/** Node `URL` vs `whatwg-url`: same TypeError, Node message `Invalid URL` (+ ERR_INVALID_URL), polyfill `Invalid URL: <input>`. */
function invalidUrlTypeError(
  a: { name: string; message: string; code?: unknown },
  b: { name: string; message: string; code?: unknown },
): boolean {
  if (a.name !== "TypeError") return false;
  const norm = (m: string) => m.replace(/^Invalid URL(?::[\s\S]*)?$/, "Invalid URL");
  return norm(a.message) === "Invalid URL" && norm(b.message) === "Invalid URL";
}

export function equal(
  a: unknown,
  b: unknown,
  hyrum?: Partial<HyrumFlags>,
  options?: EqualOptions,
): boolean {
  const ctx = ctxOf(hyrum, options);
  if (!eq(a, b, ctx, new WeakMap())) return false;
  return extras(a, b, ctx);
}

export function equalResults(
  orig: CallOutcome,
  slim: CallOutcome,
  hyrum?: Partial<HyrumFlags>,
  options?: EqualOptions,
): { ok: boolean; reason?: string } {
  const ctx = ctxOf(hyrum, options);
  const identity = ctx.sameReference || ctx.dateIdentity;
  const seen = identity ? new WeakMap<object, object>() : undefined;

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
  const pairSeen = seen ?? new WeakMap<object, object>();
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
      return { ok: false, reason: `argument mutation mismatch at index ${i}` };
    }
  }

  if (orig.ok && slim.ok) {
    if (isMomentLike(orig.value) && isMomentLike(slim.value)) {
      if (!eqMomentLike(orig.value, slim.value)) {
        return { ok: false, reason: "return value mismatch" };
      }
    } else if (isUrlLike(orig.value) && isUrlLike(slim.value)) {
      if (orig.value.href !== slim.value.href) {
        return { ok: false, reason: "return value mismatch" };
      }
    } else {
      const retSeen = identity ? pairSeen : new WeakMap<object, object>();
      if (!eq(orig.value, slim.value, ctx, retSeen)) {
        return { ok: false, reason: "return value mismatch" };
      }
      if (!extras(orig.value, slim.value, ctx)) {
        return { ok: false, reason: "return value mismatch" };
      }
    }
  }
  return { ok: true };
}

function extras(a: unknown, b: unknown, ctx: EqCtx): boolean {
  if (ctx.toString && !equalToString(a, b)) return false;
  if (ctx.json && !equalJson(a, b)) return false;
  return true;
}

function equalCustomToString(a: object, b: object): boolean {
  const sa = customToString(a);
  const sb = customToString(b);
  if (sa === undefined && sb === undefined) return true;
  return sa === sb;
}

function customToString(v: object): string | undefined {
  const ts = (v as { toString?: unknown }).toString;
  if (typeof ts !== "function") return undefined;
  if (ts === Object.prototype.toString || ts === Array.prototype.toString) return undefined;
  try {
    return String(v);
  } catch {
    return undefined;
  }
}

function equalToString(a: unknown, b: unknown): boolean {
  try {
    return String(a) === String(b);
  } catch {
    return false;
  }
}

function equalJson(a: unknown, b: unknown): boolean {
  let sa: string | undefined;
  let sb: string | undefined;
  try {
    sa = JSON.stringify(a);
  } catch {
    sa = undefined;
  }
  try {
    sb = JSON.stringify(b);
  } catch {
    sb = undefined;
  }
  if (sa === undefined && sb === undefined) return true;
  if (sa === undefined || sb === undefined) return false;
  return sa === sb;
}

function eq(
  a: unknown,
  b: unknown,
  ctx: EqCtx,
  seen: WeakMap<object, object>,
): boolean {
  if (sameValueZero(a, b, ctx)) return true;
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

  if (ctx.toString && !equalCustomToString(a, b)) return false;

  if (ctx.prototype && Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) {
    return false;
  }

  if (a instanceof Date && b instanceof Date) {
    const at = a.getTime();
    const bt = b.getTime();
    if (Number.isNaN(at) && Number.isNaN(bt)) return true;
    return at === bt;
  }
  if (a instanceof Date || b instanceof Date) return false;

  if (isMomentLike(a) && isMomentLike(b)) {
    return eqMomentLike(a, b);
  }
  if (isUrlLike(a) && isUrlLike(b)) {
    return a.href === b.href;
  }

  if (a instanceof RegExp && b instanceof RegExp) {
    return a.source === b.source && a.flags === b.flags;
  }

  if (typeof Buffer !== "undefined" && Buffer.isBuffer(a) && Buffer.isBuffer(b)) {
    return a.equals(b);
  }

  if (a instanceof ArrayBuffer && b instanceof ArrayBuffer) {
    if (a.byteLength !== b.byteLength) return false;
    return eq(new Uint8Array(a), new Uint8Array(b), ctx, seen);
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
    return eqMap(a, b, ctx, seen);
  }
  if (a instanceof Map || b instanceof Map) return false;

  if (a instanceof Set && b instanceof Set) {
    return eqSet(a, b, ctx, seen);
  }
  if (a instanceof Set || b instanceof Set) return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    void ctx.sparseArray;
    for (let i = 0; i < a.length; i++) {
      const ha = i in a;
      const hb = i in b;
      if (ha !== hb) return false;
      if (ha && !eq(a[i], b[i], ctx, seen)) return false;
    }
    return true;
  }

  const aKeys = Reflect.ownKeys(a).filter((k) => enumerableOwn(a, k));
  const bKeys = Reflect.ownKeys(b).filter((k) => enumerableOwn(b, k));
  if (aKeys.length !== bKeys.length) return false;
  if (ctx.keyOrder) {
    for (let i = 0; i < aKeys.length; i++) {
      if (aKeys[i] !== bKeys[i]) return false;
    }
    for (let i = 0; i < aKeys.length; i++) {
      const k = aKeys[i]!;
      if (!eq((a as Record<PropertyKey, unknown>)[k], (b as Record<PropertyKey, unknown>)[k], ctx, seen)) {
        return false;
      }
    }
    return true;
  }
  const bSet = new Set(bKeys);
  for (const k of aKeys) {
    if (!bSet.has(k)) return false;
    if (!eq((a as Record<PropertyKey, unknown>)[k], (b as Record<PropertyKey, unknown>)[k], ctx, seen)) {
      return false;
    }
  }
  return true;
}

function eqMap(
  a: Map<unknown, unknown>,
  b: Map<unknown, unknown>,
  ctx: EqCtx,
  seen: WeakMap<object, object>,
): boolean {
  if (a.size !== b.size) return false;
  const ae = [...a.entries()];
  const be = [...b.entries()];
  if (ctx.keyOrder || ctx.sameReference || ctx.dateIdentity) {
    for (let i = 0; i < ae.length; i++) {
      const av = ae[i]!;
      const bv = be[i]!;
      if (!eq(av[0], bv[0], ctx, seen)) return false;
      if (!eq(av[1], bv[1], ctx, seen)) return false;
    }
    return true;
  }
  const unused = be.slice();
  for (const [ak, av] of ae) {
    const idx = unused.findIndex(
      ([bk, bv]) => eq(ak, bk, ctx, new WeakMap()) && eq(av, bv, ctx, new WeakMap()),
    );
    if (idx < 0) return false;
    unused.splice(idx, 1);
  }
  return true;
}

function eqSet(
  a: Set<unknown>,
  b: Set<unknown>,
  ctx: EqCtx,
  seen: WeakMap<object, object>,
): boolean {
  if (a.size !== b.size) return false;
  if (ctx.keyOrder || ctx.sameReference || ctx.dateIdentity) {
    const aa = [...a];
    const bb = [...b];
    for (let i = 0; i < aa.length; i++) {
      if (!eq(aa[i], bb[i], ctx, seen)) return false;
    }
    return true;
  }
  const unused = [...b];
  for (const av of a) {
    const idx = unused.findIndex((bv) => eq(av, bv, ctx, new WeakMap()));
    if (idx < 0) return false;
    unused.splice(idx, 1);
  }
  return true;
}

function isUrlLike(v: unknown): v is { href: string } {
  return Boolean(
    v &&
      typeof v === "object" &&
      typeof (v as { href?: unknown }).href === "string" &&
      typeof (v as { hostname?: unknown }).hostname === "string",
  );
}

function isMomentLike(
  v: unknown,
): v is { valueOf: () => number; format: (p?: string) => string } {
  return Boolean(
    v &&
      typeof v === "object" &&
      typeof (v as { valueOf?: unknown }).valueOf === "function" &&
      typeof (v as { format?: unknown }).format === "function" &&
      typeof (v as { valueOf: () => unknown }).valueOf() === "number",
  );
}

function eqMomentLike(
  a: { valueOf: () => number; format: (p?: string) => string },
  b: { valueOf: () => number; format: (p?: string) => string },
): boolean {
  const av = a.valueOf();
  const bv = b.valueOf();
  const aNaN = Number.isNaN(av);
  const bNaN = Number.isNaN(bv);
  if (aNaN !== bNaN) return false;
  if (aNaN) return true;
  if (!Object.is(av, bv)) return false;
  return a.format("YYYY-MM-DD HH:mm:ss.SSS") === b.format("YYYY-MM-DD HH:mm:ss.SSS");
}

function enumerableOwn(obj: object, key: PropertyKey): boolean {
  const d = Object.getOwnPropertyDescriptor(obj, key);
  return d?.enumerable === true;
}

function sameValueZero(a: unknown, b: unknown, ctx: EqCtx): boolean {
  if (typeof a === "number" && typeof b === "number") {
    void ctx.nan;
    if (Number.isNaN(a) && Number.isNaN(b)) return true;
    if (ctx.signedZero) return Object.is(a, b);
    return a === b;
  }
  return a === b;
}
