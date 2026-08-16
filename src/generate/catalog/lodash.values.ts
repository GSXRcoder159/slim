/**
 * MIT License
 *
 * Original Slim implementation of lodash.values. Not derived from lodash source.
 */

import { arrayValues } from "./_internal.ts";

export function values(object: unknown): unknown[] {
  return arrayValues(object);
}
