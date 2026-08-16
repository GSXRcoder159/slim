import { randomUUID } from "node:crypto";
import type { TraceEvent } from "../envelope/types.ts";
import {
  mutatedArgIndexes,
  serialize,
  snapshot,
} from "./serialize.ts";

export interface WrapOpts {
  packageName: string;
  onEvent: (e: TraceEvent) => void;
}

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
    const wrapped = wrapFn(exports as (...args: unknown[]) => unknown, "default", opts, "");
    wrappedObjects.add(wrapped);
    return wrapped;
  }

  const cache = new Map<string | symbol, unknown>();
  const proxy = new Proxy(target, {
    get(obj, prop, receiver) {
      if (cache.has(prop)) return cache.get(prop);
      const val = Reflect.get(obj, prop, receiver);
      if (typeof val === "function" && typeof prop === "string" && !SKIP_PROPS.has(prop)) {
        const wrapped = wrapFn(val as (...args: unknown[]) => unknown, prop, opts, prop);
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
): (...args: unknown[]) => unknown {
  const cached = fnCache.get(fn);
  if (cached) return cached;

  const wrapped = function (this: unknown, ...args: unknown[]) {
    return recordCall(fn, this, args, symbol, opts);
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

  copyFnProps(wrapped, fn, propParent, opts);
  fnCache.set(fn, wrapped);
  fnCache.set(wrapped, wrapped);
  wrappedObjects.add(wrapped);
  return wrapped;
}

function copyFnProps(
  wrapped: (...args: unknown[]) => unknown,
  fn: (...args: unknown[]) => unknown,
  propParent: string,
  opts: WrapOpts,
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
): unknown {
  ensureSession();
  const tRelMs = Date.now() - sessionStartMs;
  const before = snapshot(args);
  const thisSv = shouldRecordThis(thisArg) ? serialize(thisArg) : undefined;
  try {
    const result = fn.apply(thisArg, args);
    const after = snapshot(args);
    const recorded = wrapResult(result, symbol, opts);
    const event: TraceEvent = {
      symbol,
      args: before,
      result: serialize(recorded),
      mutatedArgIndexes: mutatedArgIndexes(before, after),
      tRelMs,
      sessionId,
    };
    if (thisSv !== undefined) event.thisArg = thisSv;
    opts.onEvent(event);
    return recorded;
  } catch (err) {
    const after = snapshot(args);
    const event: TraceEvent = {
      symbol,
      args: before,
      threw: threwShape(err),
      mutatedArgIndexes: mutatedArgIndexes(before, after),
      tRelMs,
      sessionId,
    };
    if (thisSv !== undefined) event.thisArg = thisSv;
    opts.onEvent(event);
    throw err;
  }
}

function wrapResult(result: unknown, symbol: string, opts: WrapOpts): unknown {
  if (typeof result !== "function") return result;
  const wrapped = wrapFn(
    result as (...args: unknown[]) => unknown,
    `${symbol}()`,
    opts,
    symbol,
  );
  return wrapped;
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
