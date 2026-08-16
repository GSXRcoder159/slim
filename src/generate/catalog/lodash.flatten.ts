/**
 * MIT License
 *
 * Original Slim implementation of lodash.flatten. Not derived from lodash source.
 */

import { isArguments, toArrayLike } from "./_internal.ts";

export function flatten(array: unknown): unknown[] {
  const out: unknown[] = [];
  for (const item of toArrayLike(array)) {
    if (Array.isArray(item) || isArguments(item)) {
      const inner = item as ArrayLike<unknown>;
      for (let i = 0; i < inner.length; i++) out.push(inner[i]);
    } else {
      out.push(item);
    }
  }
  return out;
}
