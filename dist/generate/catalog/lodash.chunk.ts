/**
 * MIT License
 *
 * Original Slim implementation of lodash.chunk. Not affiliated with lodash authors.
 */

import { baseSlice, isIterateeCall, toInteger } from "./_internal.ts";

export function chunk(array: unknown, size?: unknown, guard?: unknown): unknown[][] {
  const n = guard
    ? isIterateeCall(array, size, guard)
      ? 1
      : Math.max(toInteger(size), 0)
    : size === undefined
      ? 1
      : Math.max(toInteger(size), 0);
  const length = array == null ? 0 : (array as { length?: number }).length ?? 0;
  if (!length || n < 1) return [];
  const list = array as ArrayLike<unknown>;
  const out: unknown[][] = [];
  for (let i = 0; i < length; ) {
    out.push(baseSlice(list, i, (i += n)));
  }
  return out;
}
