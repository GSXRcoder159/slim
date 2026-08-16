/**
 * MIT License
 *
 * Original Slim implementation of lodash.pick. Not derived from lodash source.
 */

import { pickPaths } from "./_internal.ts";

export function pick(object: unknown, ...paths: unknown[]): Record<string, unknown> {
  return pickPaths(object, paths);
}
