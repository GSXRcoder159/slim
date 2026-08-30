/**
 * MIT License
 *
 * Original Slim implementation of lodash.compact. Not affiliated with lodash authors.
 */
import { toArrayLike } from "./_internal.js";
export function compact(array) {
    const out = [];
    for (const item of toArrayLike(array)) {
        if (item)
            out.push(item);
    }
    return out;
}
//# sourceMappingURL=lodash.compact.js.map