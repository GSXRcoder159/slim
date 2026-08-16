/**
 * MIT License
 *
 * Original Slim implementation of lodash.assign. Not derived from lodash source.
 * Copies own enumerable string keys only (not symbols).
 */

import { defineData, isObject } from "./_internal.ts";

export function assign(object: unknown, ...sources: unknown[]): object {
  const dest = Object(object) as Record<string, unknown>;
  for (const source of sources) {
    if (!isObject(source)) continue;
    for (const key of Object.keys(source)) {
      defineData(dest, key, (source as Record<string, unknown>)[key]);
    }
  }
  return dest;
}
