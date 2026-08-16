/**
 * MIT License
 *
 * Original Slim implementation of lodash.keys. Not derived from lodash source.
 */

import { arrayKeys } from "./_internal.ts";

export function keys(object: unknown): string[] {
  return arrayKeys(object);
}
