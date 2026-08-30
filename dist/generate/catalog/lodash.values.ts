/**
 * MIT License
 *
 * Original Slim implementation of lodash.values. Not affiliated with lodash authors.
 */

import { arrayValues } from "./_internal.ts";

export function values(object: unknown): unknown[] {
  return arrayValues(object);
}
