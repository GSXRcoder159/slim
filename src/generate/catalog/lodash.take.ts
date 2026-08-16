/**
 * MIT License
 *
 * Original Slim implementation of lodash.take. Not derived from lodash source.
 */

import { toArrayLike, toInteger } from "./_internal.ts";

export function take(array: unknown, n?: number): unknown[] {
  const count = n === undefined ? 1 : toInteger(n);
  if (count < 1) return [];
  return toArrayLike(array).slice(0, count);
}
