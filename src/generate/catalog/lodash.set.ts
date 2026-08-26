/**
 * MIT License
 *
 * Original Slim implementation of lodash.set. Not affiliated with lodash authors.
 * Path segments __proto__, constructor, and prototype are ignored (no pollution).
 */

import { baseSet } from "./_internal.ts";

export function set(object: unknown, path: unknown, value: unknown): unknown {
  return baseSet(object, path, value);
}
