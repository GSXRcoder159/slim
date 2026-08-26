/**
 * MIT License
 *
 * Original Slim implementation of lodash.compact. Not affiliated with lodash authors.
 */

import { toArrayLike } from "./_internal.ts";

export function compact(array: unknown): unknown[] {
  const out: unknown[] = [];
  for (const item of toArrayLike(array)) {
    if (item) out.push(item);
  }
  return out;
}
