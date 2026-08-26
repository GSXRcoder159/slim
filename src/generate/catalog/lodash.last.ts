/**
 * MIT License
 *
 * Original Slim implementation of lodash.last. Not affiliated with lodash authors.
 */

import { isArrayLike } from "./_internal.ts";

export function last(array: unknown): unknown {
  if (array == null || !isArrayLike(array)) return undefined;
  const list = array as ArrayLike<unknown>;
  const len = list.length;
  return len ? list[len - 1] : undefined;
}
