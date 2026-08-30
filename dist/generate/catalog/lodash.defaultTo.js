/**
 * MIT License
 *
 * Original Slim implementation of lodash.defaultTo. Not affiliated with lodash authors.
 */
export function defaultTo(value, defaultValue) {
    return value == null || value !== value ? defaultValue : value;
}
//# sourceMappingURL=lodash.defaultTo.js.map