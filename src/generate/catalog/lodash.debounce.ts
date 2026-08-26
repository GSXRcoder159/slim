/**
 * MIT License
 *
 * Original Slim implementation of lodash.debounce. Not affiliated with lodash authors.
 * Date.now / setTimeout / clearTimeout are resolved at call time, not module load.
 */

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
