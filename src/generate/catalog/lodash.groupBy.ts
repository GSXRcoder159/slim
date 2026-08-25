/**
 * MIT License
 *
 * Original Slim implementation of lodash.groupBy. Not derived from lodash source.
 */

import { forEachCollection, resolveIteratee } from "./_internal.ts";

export function groupBy(
  collection: unknown,
  iteratee?: unknown,
): Record<string, unknown[]> {
  const fn = resolveIteratee(iteratee);
  const out: Record<string, unknown[]> = {};
  forEachCollection(collection, (value, key, col) => {
    const k = String(fn(value, key, col));
    const bucket = Object.prototype.hasOwnProperty.call(out, k) ? out[k] : undefined;
    if (bucket) bucket.push(value);
    else out[k] = [value];
  });
  return out;
}
