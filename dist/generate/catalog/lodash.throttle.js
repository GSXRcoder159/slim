/**
 * MIT License
 *
 * Original Slim implementation of lodash.throttle. Not affiliated with lodash authors.
 * Implemented as debounce with leading and trailing edges and maxWait = wait.
 */
import { debounce } from "./lodash.debounce.js";
export function throttle(func, wait, options) {
    if (typeof func !== "function") {
        throw new TypeError("Expected a function");
    }
    let callLeading = true;
    let callTrailing = true;
    if (options != null && typeof options === "object") {
        callLeading = "leading" in options ? Boolean(options.leading) : true;
        callTrailing = "trailing" in options ? Boolean(options.trailing) : true;
    }
    const debounceOpts = {
        leading: callLeading,
        trailing: callTrailing,
        maxWait: wait,
    };
    return debounce(func, wait, debounceOpts);
}
//# sourceMappingURL=lodash.throttle.js.map