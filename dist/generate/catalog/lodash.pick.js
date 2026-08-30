/**
 * MIT License
 *
 * Original Slim implementation of lodash.pick. Not affiliated with lodash authors.
 */
import { pickPaths } from "./_internal.js";
export function pick(object, ...paths) {
    return pickPaths(object, paths);
}
//# sourceMappingURL=lodash.pick.js.map