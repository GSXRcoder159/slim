/**
 * MIT License
 *
 * Original Slim implementation of lodash.assign. Not affiliated with lodash authors.
 * Copies own enumerable string keys only (not symbols).
 */

import { defineData } from "./_internal.ts";

export function assign(object: unknown, ...sources: unknown[]): object {
  const dest = Object(object) as Record<string, unknown>;
  for (const source of sources) {
    if (source == null) continue;
    const src = Object(source) as Record<string, unknown>;
    for (const key of Object.keys(src)) {
      try {
        defineData(dest, key, src[key]);
      } catch {
        /* String objects and other read-only keys: lodash assigns in sloppy mode. */
      }
    }
  }
  return dest;
}
