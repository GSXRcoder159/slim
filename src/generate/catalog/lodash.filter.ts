/**
 * MIT License
 *
 * Original Slim implementation of lodash.filter. Not derived from lodash source.
 */

import { forEachCollection, resolveIteratee } from "./_internal.ts";

export function filter(collection: unknown, predicate?: unknown): unknown[] {
  const fn = resolveIteratee(predicate);
  const out: unknown[] = [];
  forEachCollection(collection, (value, key, col) => {
    if (fn(value, key, col)) out.push(value);
  });
  return out;
}
