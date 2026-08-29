/**
 * MIT License
 *
 * Original Slim implementation of lodash.take. Not affiliated with lodash authors.
 */

import { baseSlice, toInteger } from "./_internal.ts";

export function take(array: unknown, n?: unknown, guard?: unknown): unknown[] {
  if (!(array && (array as { length?: unknown }).length)) return [];
  const count = guard || n === undefined ? 1 : toInteger(n);
  return baseSlice(array as ArrayLike<unknown>, 0, count < 0 ? 0 : count);
}
