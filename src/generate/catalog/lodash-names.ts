/**
 * MIT License
 *
 * Lodash per-method package names on npm are lowercase (`lodash.isempty`).
 * Catalog symbols keep camelCase. This module is the single fold so analyze,
 * splice, and replace agree without importing catalog implementations.
 */

export const LODASH_SYMBOLS = [
  "get",
  "set",
  "has",
  "debounce",
  "throttle",
  "once",
  "isEmpty",
  "isNil",
  "isEqual",
  "pick",
  "omit",
  "clone",
  "cloneDeep",
  "map",
  "filter",
  "groupBy",
  "uniq",
  "compact",
  "flatten",
  "camelCase",
  "kebabCase",
  "snakeCase",
  "identity",
  "noop",
  "defaultTo",
  "chunk",
  "take",
  "head",
  "first",
  "last",
  "keys",
  "values",
  "assign",
] as const;

export type LodashSymbol = (typeof LODASH_SYMBOLS)[number];

const BY_LOWER = new Map<string, LodashSymbol>(
  LODASH_SYMBOLS.map((symbol) => [symbol.toLowerCase(), symbol]),
);

export function lodashNpmName(symbol: string): string {
  return `lodash.${symbol.toLowerCase()}`;
}

/** Map `isempty` / `isEmpty` onto the registered symbol, or undefined if unsupported. */
export function canonicalLodashSymbol(suffix: string): LodashSymbol | undefined {
  return BY_LOWER.get(suffix.toLowerCase());
}
