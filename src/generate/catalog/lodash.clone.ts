/**
 * MIT License
 *
 * Original Slim implementation of lodash.clone. Not derived from lodash source.
 */

import { baseClone } from "./_internal.ts";

export function clone<T>(value: T): T {
  return baseClone(value, false) as T;
}
