/**
 * MIT License
 *
 * Original Slim implementation of lodash.take. Not affiliated with lodash authors.
 */
import { baseSlice, toInteger } from "./_internal.js";
export function take(array, n, guard) {
    if (!(array && array.length))
        return [];
    const count = guard || n === undefined ? 1 : toInteger(n);
    return baseSlice(array, 0, count < 0 ? 0 : count);
}
//# sourceMappingURL=lodash.take.js.map