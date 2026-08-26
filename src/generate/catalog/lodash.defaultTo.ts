/**
 * MIT License
 *
 * Original Slim implementation of lodash.defaultTo. Not affiliated with lodash authors.
 */

export function defaultTo<T, D>(value: T, defaultValue: D): T | D {
  return value == null || value !== value ? defaultValue : value;
}
