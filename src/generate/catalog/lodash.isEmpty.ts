/**
 * MIT License
 *
 * Original Slim implementation of lodash.isEmpty. Not affiliated with lodash authors.
 */

import { isEmptyValue } from "./_internal.ts";

export function isEmpty(value: unknown): boolean {
  return isEmptyValue(value);
}
