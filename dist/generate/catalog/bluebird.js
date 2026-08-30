/**
 * MIT License
 *
 * Native `Promise` with the Bluebird statics commonly used at call sites:
 * resolve, reject, all, race, delay, promisify.
 *
 * This is not Bluebird. There is no cancellation, promisifyAll, coroutine,
 * or Promise.map. `delay` looks up `setTimeout` at call time so a fake clock
 * can intercept it.
 */
export function resolve(value) {
    return globalThis.Promise.resolve(value);
}
export function reject(reason) {
    return globalThis.Promise.reject(reason);
}
export function all(values) {
    return globalThis.Promise.all(values);
}
export function race(values) {
    return globalThis.Promise.race(values);
}
export function delay(ms, value) {
    const schedule = globalThis.setTimeout;
    return new globalThis.Promise((res) => {
        schedule(() => res(value), ms);
    });
}
export function promisify(fn) {
    if (typeof fn !== "function") {
        throw new TypeError("Bluebird.promisify: expected a function");
    }
    return function promisified(...args) {
        return new globalThis.Promise((res, rej) => {
            const cb = (err, result) => {
                if (err)
                    rej(err);
                else
                    res(result);
            };
            fn.apply(this, [...args, cb]);
        });
    };
}
export class Promise extends globalThis.Promise {
    static delay = delay;
    static promisify = promisify;
}
export default Promise;
//# sourceMappingURL=bluebird.js.map