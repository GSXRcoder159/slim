/**
 * MIT License
 *
 * Original Slim implementation of lodash.get. Not derived from lodash source.
 */

import { baseGet } from "./_internal.ts";

export function get(object: unknown, path: unknown, defaultValue?: unknown): unknown {
  const resolved = object == null ? undefined : baseGet(object, path);
  return resolved === undefined ? defaultValue : resolved;
}
