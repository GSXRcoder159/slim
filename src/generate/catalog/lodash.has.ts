/**
 * MIT License
 *
 * Original Slim implementation of lodash.has. Not derived from lodash source.
 */

import { baseHas } from "./_internal.ts";

export function has(object: unknown, path: unknown): boolean {
  return baseHas(object, path);
}
