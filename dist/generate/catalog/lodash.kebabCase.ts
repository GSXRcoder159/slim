/**
 * MIT License
 *
 * Original Slim implementation of lodash.kebabCase. Not affiliated with lodash authors.
 */

import { words } from "./_internal.ts";

export function kebabCase(string?: unknown): string {
  return words(string)
    .map((w) => w.toLowerCase())
    .join("-");
}
