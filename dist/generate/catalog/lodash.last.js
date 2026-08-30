/**
 * MIT License
 *
 * Original Slim implementation of lodash.last. Not affiliated with lodash authors.
 */
import { isArrayLike } from "./_internal.js";
export function last(array) {
    if (array == null || !isArrayLike(array))
        return undefined;
    const list = array;
    const len = list.length;
    return len ? list[len - 1] : undefined;
}
//# sourceMappingURL=lodash.last.js.map