/**
 * MIT License
 *
 * Original Slim implementation of lodash.kebabCase. Not affiliated with lodash authors.
 */
import { words } from "./_internal.js";
export function kebabCase(string) {
    return words(string)
        .map((w) => w.toLowerCase())
        .join("-");
}
//# sourceMappingURL=lodash.kebabCase.js.map