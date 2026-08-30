/**
 * MIT License
 *
 * Original Slim implementation of lodash.has. Not affiliated with lodash authors.
 */

import { baseHas } from "./_internal.ts";

export function has(object: unknown, path: unknown): boolean {
  return baseHas(object, path);
}
