/**
 * MIT License
 *
 * Original Slim implementation of lodash.isEmpty. Not derived from lodash source.
 */

import { isEmptyValue } from "./_internal.ts";

export function isEmpty(value: unknown): boolean {
  return isEmptyValue(value);
}
