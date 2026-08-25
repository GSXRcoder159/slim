/**
 * SPDX-License-Identifier: MIT
 * Original implementation, not derived from lodash, Underscore, or OpenJS.
 * Envelope 217c102e5c34a74ba017061f1a5574a2ada6cd6a6497e6797e6eb97eafa706c4
 * Catalog lodash.get, lodash.debounce
 * Evidence: .slim/lodash/evidence.md
 *
 * Slim is not affiliated with the original package authors.
 * Differential fuzzing is evidence, not proof.
 */

const DEEP_PATH = /[.[\]]/;

function toKey(value: unknown): PropertyKey {
  if (typeof value === "symbol") return value;
  if (typeof value === "number") {
    if (Object.is(value, -0)) return "-0";
    return String(value);
  }
  if (value == null) return String(value);
  return typeof value === "string" ? value : String(value);
}

function isKey(value: unknown, object?: unknown): boolean {
  if (Array.isArray(value)) return false;
  const t = typeof value;
  if (t === "number" || t === "symbol" || t === "boolean" || value == null) return true;
  if (t !== "string") return false;
  if (!DEEP_PATH.test(value as string)) return true;
  return object != null && (value as string) in Object(object);
}

function parseStringPath(path: string): string[] {
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

function castPath(path: unknown, object?: unknown): PropertyKey[] {
  if (Array.isArray(path)) return path.map((p) => toKey(p));
  if (isKey(path, object)) return [toKey(path)];
  if (typeof path === "string") return parseStringPath(path);
  return [toKey(path)];
}

function readProp(object: object, key: PropertyKey): unknown {
  return (object as Record<PropertyKey, unknown>)[key];
}

function baseGet(object: unknown, path: unknown): unknown {
  const segs = castPath(path, object);
  if (segs.length === 0) return undefined;
  let cur: unknown = object;
  for (const seg of segs) {
    if (cur == null) return undefined;
    cur = readProp(Object(cur) as object, seg);
  }
  return cur;
}

export function get(object: unknown, path: unknown, defaultValue?: unknown): unknown {
  const resolved = object == null ? undefined : baseGet(object, path);
  return resolved === undefined ? defaultValue : resolved;
}

export interface DebounceOptions {
  leading?: boolean;
  trailing?: boolean;
  maxWait?: number;
}

export interface Debounced<F extends (...args: never[]) => unknown> {
  (...args: Parameters<F>): ReturnType<F> | undefined;
  cancel(): void;
  flush(): ReturnType<F> | undefined;
}

function now(): number {
  return Date.now();
}

function startTimer(cb: () => void, ms: number): ReturnType<typeof setTimeout> {
  return setTimeout(cb, ms);
}

function stopTimer(id: ReturnType<typeof setTimeout> | undefined): void {
  if (id !== undefined) clearTimeout(id);
}

export function debounce<F extends (...args: never[]) => unknown>(
  func: F,
  wait?: number,
  options?: DebounceOptions,
): Debounced<F> {
  if (typeof func !== "function") {
    throw new TypeError("Expected a function");
  }

  const delay = Number(wait) || 0;
  let callLeading = false;
  let callTrailing = true;
  let useMaxWait = false;
  let maxDelay = 0;

  if (options != null && typeof options === "object") {
    callLeading = Boolean(options.leading);
    callTrailing = "trailing" in options ? Boolean(options.trailing) : true;
    useMaxWait = Object.prototype.hasOwnProperty.call(options, "maxWait");
    if (useMaxWait) {
      maxDelay = Math.max(Number(options.maxWait) || 0, delay);
    }
  }

  let lastArgs: unknown[] | undefined;
  let lastThis: unknown;
  let lastResult: ReturnType<F> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastCall: number | undefined;
  let lastFire = 0;

  function invoke(time: number): ReturnType<F> | undefined {
    const args = lastArgs;
    const self = lastThis;
    lastArgs = undefined;
    lastThis = undefined;
    lastFire = time;
    lastResult = func.apply(self, (args ?? []) as never) as ReturnType<F>;
    return lastResult;
  }

  function remaining(time: number): number {
    const sinceCall = time - (lastCall ?? 0);
    const sinceFire = time - lastFire;
    const waitLeft = delay - sinceCall;
    return useMaxWait ? Math.min(waitLeft, maxDelay - sinceFire) : waitLeft;
  }

  function shouldFire(time: number): boolean {
    if (lastCall === undefined) return true;
    const sinceCall = time - lastCall;
    const sinceFire = time - lastFire;
    return sinceCall >= delay || sinceCall < 0 || (useMaxWait && sinceFire >= maxDelay);
  }

  function trailingEdge(time: number): ReturnType<F> | undefined {
    timer = undefined;
    if (callTrailing && lastArgs !== undefined) return invoke(time);
    lastArgs = undefined;
    lastThis = undefined;
    return lastResult;
  }

  function onTimer(): void {
    const time = now();
    if (shouldFire(time)) {
      trailingEdge(time);
      return;
    }
    timer = startTimer(onTimer, remaining(time));
  }

  function leadingEdge(time: number): ReturnType<F> | undefined {
    lastFire = time;
    timer = startTimer(onTimer, delay);
    return callLeading ? invoke(time) : lastResult;
  }

  function wrapped(this: unknown, ...args: Parameters<F>): ReturnType<F> | undefined {
    const time = now();
    const firing = shouldFire(time);
    lastArgs = args;
    lastThis = this;
    lastCall = time;

    if (firing) {
      if (timer === undefined) return leadingEdge(lastCall);
      if (useMaxWait) {
        timer = startTimer(onTimer, delay);
        return invoke(lastCall);
      }
    }
    if (timer === undefined) timer = startTimer(onTimer, delay);
    return lastResult;
  }

  wrapped.cancel = function cancel(): void {
    stopTimer(timer);
    lastFire = 0;
    lastArgs = undefined;
    lastCall = undefined;
    lastThis = undefined;
    timer = undefined;
  };

  wrapped.flush = function flush(): ReturnType<F> | undefined {
    return timer === undefined ? lastResult : trailingEdge(now());
  };

  return wrapped as Debounced<F>;
}
export default {
  get,
  debounce
};
