/**
 * MIT License
 *
 * Original Slim implementation of lodash.throttle. Not affiliated with lodash authors.
 * Implemented as debounce with leading and trailing edges and maxWait = wait.
 */

import { debounce, type DebounceOptions, type Debounced } from "./lodash.debounce.ts";

export interface ThrottleOptions {
  leading?: boolean;
  trailing?: boolean;
}

export function throttle<F extends (...args: never[]) => unknown>(
  func: F,
  wait?: number,
  options?: ThrottleOptions,
): Debounced<F> {
  if (typeof func !== "function") {
    throw new TypeError("Expected a function");
  }
  let callLeading = true;
  let callTrailing = true;
  if (options != null && typeof options === "object") {
    callLeading = "leading" in options ? Boolean(options.leading) : true;
    callTrailing = "trailing" in options ? Boolean(options.trailing) : true;
  }
  const debounceOpts: DebounceOptions = {
    leading: callLeading,
    trailing: callTrailing,
    maxWait: wait,
  };
  return debounce(func, wait, debounceOpts);
}
