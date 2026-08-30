/**
 * MIT License
 *
 * Original Slim implementation of lodash.snakeCase. Not affiliated with lodash authors.
 */
import { words } from "./_internal.js";
export function snakeCase(string) {
    return words(string)
        .map((w) => w.toLowerCase())
        .join("_");
}
//# sourceMappingURL=lodash.snakeCase.js.map