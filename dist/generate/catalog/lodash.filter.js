/**
 * MIT License
 *
 * Original Slim implementation of lodash.filter. Not affiliated with lodash authors.
 */
import { forEachCollection, resolveIteratee } from "./_internal.js";
export function filter(collection, predicate) {
    const fn = resolveIteratee(predicate);
    const out = [];
    forEachCollection(collection, (value, key, col) => {
        if (fn(value, key, col))
            out.push(value);
    });
    return out;
}
//# sourceMappingURL=lodash.filter.js.map