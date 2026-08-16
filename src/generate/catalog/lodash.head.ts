/**
 * MIT License
 *
 * Original Slim implementation of lodash.head. Not derived from lodash source.
 */

import { isArrayLike } from "./_internal.ts";

export function head(array: unknown): unknown {
  if (array == null || !isArrayLike(array)) return undefined;
  return (array as ArrayLike<unknown>)[0];
}

export const first = head;
