/**
 * MIT License
 *
 * Original Slim implementation of lodash.keys. Not affiliated with lodash authors.
 */

import { arrayKeys } from "./_internal.ts";

export function keys(object: unknown): string[] {
  return arrayKeys(object);
}
