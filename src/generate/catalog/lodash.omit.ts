/**
 * MIT License
 *
 * Original Slim implementation of lodash.omit. Not affiliated with lodash authors.
 */

import { omitPaths } from "./_internal.ts";

export function omit(object: unknown, ...paths: unknown[]): Record<string, unknown> {
  return omitPaths(object, paths);
}
