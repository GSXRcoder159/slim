/**
 * MIT License
 *
 * Original Slim implementation of lodash.cloneDeep. Not affiliated with lodash authors.
 * Own `__proto__` keys are copied with defineProperty (no prototype pollution).
 */

import { baseClone } from "./_internal.ts";

export function cloneDeep<T>(value: T): T {
  return baseClone(value, true) as T;
}
