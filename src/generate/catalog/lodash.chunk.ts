/**
 * MIT License
 *
 * Original Slim implementation of lodash.chunk. Not derived from lodash source.
 */

import { toArrayLike, toInteger } from "./_internal.ts";

export function chunk(array: unknown, size?: number): unknown[][] {
  const list = toArrayLike(array);
  const n = size === undefined ? 1 : toInteger(size);
  if (n < 1 || list.length === 0) return [];
  const out: unknown[][] = [];
  for (let i = 0; i < list.length; i += n) {
    out.push(list.slice(i, i + n));
  }
  return out;
}
