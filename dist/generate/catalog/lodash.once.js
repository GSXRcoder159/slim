/**
 * MIT License
 *
 * Original Slim implementation of lodash.once. Not affiliated with lodash authors.
 */
export function once(func) {
    if (typeof func !== "function") {
        throw new TypeError("Expected a function");
    }
    let called = false;
    let result;
    return function (...args) {
        if (called)
            return result;
        called = true;
        result = func.apply(this, args);
        return result;
    };
}
//# sourceMappingURL=lodash.once.js.map