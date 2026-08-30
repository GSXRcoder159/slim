/**
 * MIT License
 *
 * Original Slim implementation of lodash.cloneDeep. Not affiliated with lodash authors.
 * Own `__proto__` keys are copied with defineProperty (no prototype pollution).
 */
import { baseClone } from "./_internal.js";
export function cloneDeep(value) {
    return baseClone(value, true);
}
//# sourceMappingURL=lodash.cloneDeep.js.map