/**
 * MIT License
 *
 * Original Slim implementation of lodash.set. Not affiliated with lodash authors.
 * Path segments __proto__, constructor, and prototype are ignored (no pollution).
 */
import { baseSet } from "./_internal.js";
export function set(object, path, value) {
    return baseSet(object, path, value);
}
//# sourceMappingURL=lodash.set.js.map