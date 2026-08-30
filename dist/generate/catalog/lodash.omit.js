/**
 * MIT License
 *
 * Original Slim implementation of lodash.omit. Not affiliated with lodash authors.
 */
import { omitPaths } from "./_internal.js";
export function omit(object, ...paths) {
    return omitPaths(object, paths);
}
//# sourceMappingURL=lodash.omit.js.map