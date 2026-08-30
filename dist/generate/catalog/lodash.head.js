/**
 * MIT License
 *
 * Original Slim implementation of lodash.head. Not affiliated with lodash authors.
 */
import { isArrayLike } from "./_internal.js";
export function head(array) {
    if (array == null || !isArrayLike(array))
        return undefined;
    return array[0];
}
export const first = head;
//# sourceMappingURL=lodash.head.js.map