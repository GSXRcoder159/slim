/**
 * MIT License
 *
 * Original Slim implementation of lodash.map. Not affiliated with lodash authors.
 */
import { forEachCollection, resolveIteratee } from "./_internal.js";
export function map(collection, iteratee) {
    const fn = resolveIteratee(iteratee);
    const out = [];
    forEachCollection(collection, (value, key, col) => {
        out.push(fn(value, key, col));
    });
    return out;
}
//# sourceMappingURL=lodash.map.js.map