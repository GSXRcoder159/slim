/**
 * MIT License
 *
 * Original Slim implementation of lodash.assign. Not affiliated with lodash authors.
 * Copies own enumerable string keys only (not symbols).
 */
import { defineData } from "./_internal.js";
export function assign(object, ...sources) {
    const dest = Object(object);
    for (const source of sources) {
        if (source == null)
            continue;
        const src = Object(source);
        for (const key of Object.keys(src)) {
            try {
                defineData(dest, key, src[key]);
            }
            catch {
                /* String objects and other read-only keys: lodash assigns in sloppy mode. */
            }
        }
    }
    return dest;
}
//# sourceMappingURL=lodash.assign.js.map