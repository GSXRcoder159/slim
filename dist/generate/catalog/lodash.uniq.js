/**
 * MIT License
 *
 * Original Slim implementation of lodash.uniq. Not affiliated with lodash authors.
 * Uniqueness uses SameValueZero (NaN equals NaN, +0 equals -0).
 */
import { toArrayLike } from "./_internal.js";
export function uniq(array) {
    const list = toArrayLike(array);
    const seen = new Set();
    const out = [];
    for (const item of list) {
        if (seen.has(item))
            continue;
        seen.add(item);
        out.push(item);
    }
    return out;
}
//# sourceMappingURL=lodash.uniq.js.map