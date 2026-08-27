import { randomUUID } from "node:crypto";
import type { SlimValue, TraceEvent } from "../envelope/types.ts";
import type { TraceErrorRecord } from "./session.ts";
import {
  createWalker,
  mutatedArgIndexes,
  snapshot,
} from "./serialize.ts";
import { captureUserSite } from "./stack.ts";

export interface WrapOpts {
  packageName: string;
  onEvent: (e: TraceEvent) => void;
  onError?: (e: TraceErrorRecord) => void;
}

type WrapMeta = {
  parentOriginId?: string;
  resultMember?: string;
};

const SKIP_PROPS = new Set([
  "length",
  "name",
  "prototype",
  "arguments",
  "caller",
  "callee",
  "then",
]);

const wrappedObjects = new WeakSet<object>();
const fnCache = new WeakMap<object, Map<string, (...args: unknown[]) => unknown>>();
const wrapperSymbol = new WeakMap<object, string>();
let recordDepth = 0;

let sessionId = "";
let sessionStartMs = 0;

function ensureSession(): void {
  if (!sessionId) {
    sessionId = randomUUID();
    sessionStartMs = Date.now();
  }
}

function isNativeFn(fn: Function): boolean {
  if (wrapperSymbol.has(fn) || wrappedObjects.has(fn)) return false;
  try {
    return Function.prototype.toString.call(fn).includes("[native code]");
  } catch {
    return false;
  }
}

export function wrapExports(exports: unknown, opts: WrapOpts): unknown {
  if (exports === null || (typeof exports !== "object" && typeof exports !== "function")) {
    return exports;
  }
  const target = exports as object;
  if (wrappedObjects.has(target)) return exports;

  if (typeof exports === "function") {
    const wrapped = wrapFn(exports as (...args: unknown[]) => unknown, "default", opts, "", {});
    wrappedObjects.add(wrapped);
    return wrapped;
  }

  const cache = new Map<string | symbol, unknown>();
  const proxy = new Proxy(target, {
    get(obj, prop, receiver) {
      if (cache.has(prop)) return cache.get(prop);
      const val = Reflect.get(obj, prop, receiver);
      if (typeof val === "function" && typeof prop === "string" && !SKIP_PROPS.has(prop)) {
        const wrapped = wrapFn(val as (...args: unknown[]) => unknown, prop, opts, prop, {});
        cache.set(prop, wrapped);
        return wrapped;
      }
      return val;
    },
  });
  wrappedObjects.add(proxy);
  return proxy;
}

function wrapFn(
  fn: (...args: unknown[]) => unknown,
  symbol: string,
  opts: WrapOpts,
  propParent: string,
  meta: WrapMeta,
): (...args: unknown[]) => unknown {
  if (isNativeFn(fn)) return fn;
  if (wrapperSymbol.get(fn) === symbol) {
    copyFnProps(fn, fn, propParent, opts, meta);
    return fn;
  }
  if (!meta.parentOriginId) {
    const bySymbol = fnCache.get(fn);
    const cached = bySymbol?.get(symbol);
    if (cached) return cached;
    const existing = bySymbol?.values().next().value;
    if (existing) return aliasWrapped(existing, fn, symbol, opts, meta, propParent);
  }
  if (wrapperSymbol.has(fn)) {
    return aliasWrapped(fn, fn, symbol, opts, meta, propParent);
  }

  const wrapped = makeCallWrapper(fn, symbol, opts, meta);
  cacheWrapper(fn, symbol, wrapped);
  copyFnProps(wrapped, fn, propParent, opts, meta);
  return wrapped;
}

function aliasWrapped(
  inner: (...args: unknown[]) => unknown,
  cacheKey: object,
  symbol: string,
  opts: WrapOpts,
  meta: WrapMeta,
  propParent = symbol,
): (...args: unknown[]) => unknown {
  const wrapped = makeCallWrapper(inner, symbol, opts, meta);
  cacheWrapper(cacheKey, symbol, wrapped);
  copyOwnFunctionsShallow(wrapped, inner);
  return wrapped;
}

function copyOwnFunctionsShallow(
  wrapped: (...args: unknown[]) => unknown,
  inner: (...args: unknown[]) => unknown,
): void {
  const dest = wrapped as unknown as Record<string, unknown>;
  const src = inner as unknown as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(inner)) {
    if (SKIP_PROPS.has(key)) continue;
    const val = src[key];
    if (typeof val === "function") {
      try {
        dest[key] = val;
      } catch {
        /* ignore */
      }
    }
  }
}

function cacheWrapper(
  fn: object,
  symbol: string,
  wrapped: (...args: unknown[]) => unknown,
): void {
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

function makeCallWrapper(
  fn: (...args: unknown[]) => unknown,
  symbol: string,
  opts: WrapOpts,
  meta: WrapMeta,
): (...args: unknown[]) => unknown {
  const wrapped = function (this: unknown, ...args: unknown[]) {
    if (new.target) {
      return recordConstruct(fn, args, new.target as Function, symbol, opts, meta);
    }
    return recordCall(fn, this, args, symbol, opts, meta);
  };
  try {
    Object.defineProperty(wrapped, "name", { value: fn.name, configurable: true });
    Object.defineProperty(wrapped, "length", { value: fn.length, configurable: true });
  } catch {
    /* ignore */
  }
  try {
    Object.setPrototypeOf(wrapped, Object.getPrototypeOf(fn));
  } catch {
    /* ignore */
  }
  try {
    wrapped.prototype = (fn as { prototype?: unknown }).prototype;
  } catch {
    /* ignore */
  }
  return wrapped;
}

function copyFnProps(
  wrapped: (...args: unknown[]) => unknown,
  fn: (...args: unknown[]) => unknown,
  propParent: string,
  opts: WrapOpts,
  meta: WrapMeta,
): void {
  for (const key of Object.getOwnPropertyNames(fn)) {
    if (SKIP_PROPS.has(key)) continue;
    let desc: PropertyDescriptor | undefined;
    try {
      desc = Object.getOwnPropertyDescriptor(fn, key);
    } catch {
      continue;
    }
    if (!desc || (desc.get && !("value" in desc))) continue;
    const val = (fn as unknown as Record<string, unknown>)[key];
    const nestedSymbol = propParent ? `${propParent}.${key}` : key;
    if (typeof val === "function") {
      try {
        (wrapped as unknown as Record<string, unknown>)[key] =
          val === fn
            ? wrapped
            : wrapFn(
                val as (...args: unknown[]) => unknown,
                nestedSymbol,
                opts,
                nestedSymbol,
                meta.parentOriginId
                  ? { parentOriginId: meta.parentOriginId, resultMember: key }
                  : {},
              );
      } catch {
        /* ignore */
      }
    } else {
      try {
        (wrapped as unknown as Record<string, unknown>)[key] = val;
      } catch {
        /* ignore */
      }
    }
  }
}

function emitSerializeError(opts: WrapOpts, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  opts.onError?.({ t: "error", kind: "serialize", message });
}

function isPackageInternal(file: string): boolean {
  return /(?:^|\/)node_modules\//.test(file.replace(/\\/g, "/"));
}

function recordConstruct(
  fn: Function,
  args: unknown[],
  newTarget: Function,
  symbol: string,
  opts: WrapOpts,
  meta: WrapMeta,
): unknown {
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
    let walker: ReturnType<typeof createWalker>;
    let beforeLive: SlimValue[];
    let beforeSnap: ReturnType<typeof snapshot>;
    try {
      walker = createWalker();
      beforeLive = args.map((a) => walker.value(a));
      beforeSnap = snapshot(args);
    } catch (err) {
      emitSerializeError(opts, err);
      return wrapResult(Reflect.construct(fn, args, newTarget), symbol, opts, originId);
    }
    try {
      const result = Reflect.construct(fn, args, newTarget);
      const afterSnap = snapshot(args);
      const recorded = wrapResult(result, symbol, opts, originId);
      const event: TraceEvent = {
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
      if ((event.mutatedArgIndexes ?? []).length) event.argsAfter = afterSnap;
      if (meta.parentOriginId) event.parentOriginId = meta.parentOriginId;
      if (meta.resultMember !== undefined) event.resultMember = meta.resultMember;
      if (site) event.site = site;
      opts.onEvent(event);
      return recorded;
    } catch (err) {
      const afterSnap = snapshot(args);
      const event: TraceEvent = {
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
      if ((event.mutatedArgIndexes ?? []).length) event.argsAfter = afterSnap;
      if (meta.parentOriginId) event.parentOriginId = meta.parentOriginId;
      if (meta.resultMember !== undefined) event.resultMember = meta.resultMember;
      if (site) event.site = site;
      opts.onEvent(event);
      throw err;
    }
  } finally {
    recordDepth--;
  }
}

function recordCall(
  fn: (...args: unknown[]) => unknown,
  thisArg: unknown,
  args: unknown[],
  symbol: string,
  opts: WrapOpts,
  meta: WrapMeta,
): unknown {
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
    let walker: ReturnType<typeof createWalker>;
    let beforeLive: SlimValue[];
    let thisSv: SlimValue | undefined;
    let beforeSnap: ReturnType<typeof snapshot>;
    try {
      walker = createWalker();
      beforeLive = args.map((a) => walker.value(a));
      thisSv = shouldRecordThis(thisArg) ? walker.value(thisArg) : undefined;
      beforeSnap = snapshot(args);
    } catch (err) {
      emitSerializeError(opts, err);
      const result = fn.apply(thisArg, args);
      return wrapResult(result, symbol, opts, originId);
    }
    try {
      const result = fn.apply(thisArg, args);
      const after = snapshotAfter(args, thisArg, thisSv !== undefined);
      const recorded = wrapResult(result, symbol, opts, originId);
      const event: TraceEvent = {
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
      if ((event.mutatedArgIndexes ?? []).length) event.argsAfter = after.args;
      if (thisSv !== undefined) {
        event.thisArg = thisSv;
        event.thisAfter = after.thisArg;
      }
      if (meta.parentOriginId) event.parentOriginId = meta.parentOriginId;
      if (meta.resultMember !== undefined) event.resultMember = meta.resultMember;
      if (site) event.site = site;
      opts.onEvent(event);
      return recorded;
    } catch (err) {
      const after = snapshotAfter(args, thisArg, thisSv !== undefined);
      const event: TraceEvent = {
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
      if ((event.mutatedArgIndexes ?? []).length) event.argsAfter = after.args;
      if (thisSv !== undefined) {
        event.thisArg = thisSv;
        event.thisAfter = after.thisArg;
      }
      if (meta.parentOriginId) event.parentOriginId = meta.parentOriginId;
      if (meta.resultMember !== undefined) event.resultMember = meta.resultMember;
      if (site) event.site = site;
      opts.onEvent(event);
      throw err;
    }
  } finally {
    recordDepth--;
  }
}

function wrapResult(
  result: unknown,
  symbol: string,
  opts: WrapOpts,
  parentOriginId: string,
): unknown {
  if (typeof result === "function") {
    return wrapFn(
      result as (...args: unknown[]) => unknown,
      `${symbol}()`,
      opts,
      symbol,
      { parentOriginId, resultMember: "" },
    );
  }
  if (result instanceof Promise) {
    return result.then((v) => wrapResult(v, symbol, opts, parentOriginId));
  }
  if (isThenable(result)) {
    const orig = result;
    return {
      then(
        onFulfilled?: (value: unknown) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) {
        return orig.then(
          (v) => {
            const next = wrapResult(v, symbol, opts, parentOriginId);
            return onFulfilled ? onFulfilled(next) : next;
          },
          onRejected,
        );
      },
    };
  }
  return result;
}

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return Boolean(
    v &&
      (typeof v === "object" || typeof v === "function") &&
      typeof (v as { then?: unknown }).then === "function",
  );
}

function shouldRecordThis(thisArg: unknown): boolean {
  if (thisArg === undefined || thisArg === null) return false;
  if (thisArg === globalThis) return false;
  return typeof thisArg === "object" || typeof thisArg === "function";
}

function snapshotAfter(
  args: unknown[],
  thisArg: unknown,
  recordThis: boolean,
): { args: SlimValue[]; thisArg?: SlimValue } {
  const w = createWalker();
  return {
    args: args.map((a) => w.value(a)),
    thisArg: recordThis ? w.value(thisArg) : undefined,
  };
}

function threwShape(err: unknown): { name: string; message: string; code?: string } {
  if (err instanceof Error) {
    const code = (err as Error & { code?: unknown }).code;
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
