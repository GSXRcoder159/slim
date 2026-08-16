/**
 * MIT License
 *
 * Original Slim implementation of lodash.snakeCase. Not derived from lodash source.
 */

import { words } from "./_internal.ts";

export function snakeCase(string?: unknown): string {
  return words(string)
    .map((w) => w.toLowerCase())
    .join("_");
}
