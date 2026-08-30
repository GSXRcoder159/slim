/**
 * Deep clone of call arguments so orig and slim cannot share mutable state.
 * Functions are returned by reference (not cloned). Cycles use WeakMap.
 */
export declare function clone<T>(value: T, seen?: WeakMap<object, unknown>): T;
/** One WeakMap across args and the receiver so aliases and cycles survive isolation clones. */
export declare function cloneInvocation(args: unknown[], thisArg?: unknown): {
    args: unknown[];
    thisArg?: unknown;
};
