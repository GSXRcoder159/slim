/**
 * MIT License
 *
 * Original Slim implementation of lodash.groupBy. Not affiliated with lodash authors.
 */
import { forEachCollection, resolveIteratee } from "./_internal.js";
export function groupBy(collection, iteratee) {
    const fn = resolveIteratee(iteratee);
    const out = {};
    forEachCollection(collection, (value, key, col) => {
        const k = String(fn(value, key, col));
        const bucket = Object.prototype.hasOwnProperty.call(out, k) ? out[k] : undefined;
        if (bucket)
            bucket.push(value);
        else
            out[k] = [value];
    });
    return out;
}
//# sourceMappingURL=lodash.groupBy.js.map