/**
 * MIT License
 *
 * Original Slim implementation of lodash.get. Not affiliated with lodash authors.
 */
import { baseGet } from "./_internal.js";
export function get(object, path, defaultValue) {
    const resolved = object == null ? undefined : baseGet(object, path);
    return resolved === undefined ? defaultValue : resolved;
}
//# sourceMappingURL=lodash.get.js.map