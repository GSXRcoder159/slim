/**
 * MIT License
 *
 * Original Slim implementation of lodash.pick. Not affiliated with lodash authors.
 */

import { pickPaths } from "./_internal.ts";

export function pick(object: unknown, ...paths: unknown[]): Record<string, unknown> {
  return pickPaths(object, paths);
}
