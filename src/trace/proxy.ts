import { randomUUID } from "node:crypto";
import type { TraceEvent } from "../envelope/types.ts";
import {
  createWalker,
  mutatedArgIndexes,
  snapshot,
} from "./serialize.ts";
import { captureUserSite } from "./stack.ts";

export interface WrapOpts {
  packageName: string;
  onEvent: (e: TraceEvent) => void;
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
const fnCache = new WeakMap<object, (...args: unknown[]) => unknown>();

let sessionId = "";
let sessionStartMs = 0;

function ensureSession(): void {
  if (!sessionId) {
    sessionId = randomUUID();
    sessionStartMs = Date.now();
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
  if (!meta.parentOriginId) {
    const cached = fnCache.get(fn);
    if (cached) return cached;
  }

  const wrapped = function (this: unknown, ...args: unknown[]) {
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

  if (!meta.parentOriginId) {
    fnCache.set(fn, wrapped);
    fnCache.set(wrapped, wrapped);
  }
  wrappedObjects.add(wrapped);
  copyFnProps(wrapped, fn, propParent, opts, meta);
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
        (wrapped as unknown as Record<string, unknown>)[key] = wrapFn(
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
  const walker = createWalker();
  const beforeLive = args.map((a) => walker.value(a));
  const thisSv = shouldRecordThis(thisArg) ? walker.value(thisArg) : undefined;
  const beforeSnap = snapshot(args);
  try {
    const result = fn.apply(thisArg, args);
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
    if (meta.parentOriginId) event.parentOriginId = meta.parentOriginId;
    if (meta.resultMember !== undefined) event.resultMember = meta.resultMember;
    if (thisSv !== undefined) event.thisArg = thisSv;
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
    if (meta.parentOriginId) event.parentOriginId = meta.parentOriginId;
    if (meta.resultMember !== undefined) event.resultMember = meta.resultMember;
    if (thisSv !== undefined) event.thisArg = thisSv;
    if (site) event.site = site;
    opts.onEvent(event);
    throw err;
  }
}

function wrapResult(
  result: unknown,
  symbol: string,
  opts: WrapOpts,
  parentOriginId: string,
): unknown {
  if (typeof result !== "function") return result;
  return wrapFn(
    result as (...args: unknown[]) => unknown,
    `${symbol}()`,
    opts,
    symbol,
    { parentOriginId, resultMember: "" },
  );
}

function shouldRecordThis(thisArg: unknown): boolean {
  if (thisArg === undefined || thisArg === null) return false;
  if (thisArg === globalThis) return false;
  return typeof thisArg === "object" || typeof thisArg === "function";
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
