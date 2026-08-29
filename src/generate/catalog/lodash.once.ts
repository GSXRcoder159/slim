/**
 * MIT License
 *
 * Original Slim implementation of lodash.once. Not affiliated with lodash authors.
 */

export function once<F extends (...args: never[]) => unknown>(func: F): F {
  if (typeof func !== "function") {
    throw new TypeError("Expected a function");
  }
  let called = false;
  let result: ReturnType<F>;
  return function (this: unknown, ...args: Parameters<F>): ReturnType<F> {
    if (called) return result;
    called = true;
    result = func.apply(this, args) as ReturnType<F>;
    return result;
  } as F;
}
