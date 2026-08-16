/**
 * MIT License
 *
 * Original Slim implementation of lodash.map. Not derived from lodash source.
 */

import { forEachCollection, resolveIteratee } from "./_internal.ts";

export function map(collection: unknown, iteratee?: unknown): unknown[] {
  const fn = resolveIteratee(iteratee);
  const out: unknown[] = [];
  forEachCollection(collection, (value, key, col) => {
    out.push(fn(value, key, col));
  });
  return out;
}
