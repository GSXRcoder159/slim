/**
 * MIT License
 *
 * Original Slim implementation of lodash.isEqual. Not derived from lodash source.
 */

import { baseIsEqual } from "./_internal.ts";

export function isEqual(value: unknown, other: unknown): boolean {
  return baseIsEqual(value, other);
}
