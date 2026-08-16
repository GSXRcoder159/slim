/**
 * MIT License
 *
 * Original Slim implementation of lodash.defaultTo. Not derived from lodash source.
 */

export function defaultTo<T, D>(value: T, defaultValue: D): T | D {
  return value == null || value !== value ? defaultValue : value;
}
