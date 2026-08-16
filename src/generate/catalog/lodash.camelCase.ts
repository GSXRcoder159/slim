/**
 * MIT License
 *
 * Original Slim implementation of lodash.camelCase. Not derived from lodash source.
 */

import { capitalizeWord, words } from "./_internal.ts";

export function camelCase(string?: unknown): string {
  const parts = words(string);
  if (parts.length === 0) return "";
  const first = parts[0]!.toLowerCase();
  let out = first;
  for (let i = 1; i < parts.length; i++) out += capitalizeWord(parts[i]!);
  return out;
}
