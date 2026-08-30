/**
 * MIT License
 *
 * Original Slim implementation of lodash.flatten. Not affiliated with lodash authors.
 */
import { isArguments, toArrayLike } from "./_internal.js";
export function flatten(array) {
    const out = [];
    for (const item of toArrayLike(array)) {
        if (Array.isArray(item) || isArguments(item)) {
            const inner = item;
            for (let i = 0; i < inner.length; i++)
                out.push(inner[i]);
        }
        else {
            out.push(item);
        }
    }
    return out;
}
//# sourceMappingURL=lodash.flatten.js.map