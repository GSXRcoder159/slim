/**
 * MIT License
 *
 * Original Slim implementation of lodash.debounce. Not affiliated with lodash authors.
 * Date.now / setTimeout / clearTimeout are resolved at call time, not module load.
 */
function now() {
    return Date.now();
}
function startTimer(cb, ms) {
    return setTimeout(cb, ms);
}
function stopTimer(id) {
    if (id !== undefined)
        clearTimeout(id);
}
export function debounce(func, wait, options) {
    if (typeof func !== "function") {
        throw new TypeError("Expected a function");
    }
    const delay = Number(wait) || 0;
    let callLeading = false;
    let callTrailing = true;
    let useMaxWait = false;
    let maxDelay = 0;
    if (options != null && typeof options === "object") {
        callLeading = Boolean(options.leading);
        callTrailing = "trailing" in options ? Boolean(options.trailing) : true;
        useMaxWait = Object.prototype.hasOwnProperty.call(options, "maxWait");
        if (useMaxWait) {
            maxDelay = Math.max(Number(options.maxWait) || 0, delay);
        }
    }
    let lastArgs;
    let lastThis;
    let lastResult;
    let timer;
    let lastCall;
    let lastFire = 0;
    function invoke(time) {
        const args = lastArgs;
        const self = lastThis;
        lastArgs = undefined;
        lastThis = undefined;
        lastFire = time;
        lastResult = func.apply(self, (args ?? []));
        return lastResult;
    }
    function remaining(time) {
        const sinceCall = time - (lastCall ?? 0);
        const sinceFire = time - lastFire;
        const waitLeft = delay - sinceCall;
        return useMaxWait ? Math.min(waitLeft, maxDelay - sinceFire) : waitLeft;
    }
    function shouldFire(time) {
        if (lastCall === undefined)
            return true;
        const sinceCall = time - lastCall;
        const sinceFire = time - lastFire;
        return sinceCall >= delay || sinceCall < 0 || (useMaxWait && sinceFire >= maxDelay);
    }
    function trailingEdge(time) {
        timer = undefined;
        if (callTrailing && lastArgs !== undefined)
            return invoke(time);
        lastArgs = undefined;
        lastThis = undefined;
        return lastResult;
    }
    function onTimer() {
        const time = now();
        if (shouldFire(time)) {
            trailingEdge(time);
            return;
        }
        timer = startTimer(onTimer, remaining(time));
    }
    function leadingEdge(time) {
        lastFire = time;
        timer = startTimer(onTimer, delay);
        return callLeading ? invoke(time) : lastResult;
    }
    function wrapped(...args) {
        const time = now();
        const firing = shouldFire(time);
        lastArgs = args;
        lastThis = this;
        lastCall = time;
        if (firing) {
            if (timer === undefined)
                return leadingEdge(lastCall);
            if (useMaxWait) {
                timer = startTimer(onTimer, delay);
                return invoke(lastCall);
            }
        }
        if (timer === undefined)
            timer = startTimer(onTimer, delay);
        return lastResult;
    }
    wrapped.cancel = function cancel() {
        stopTimer(timer);
        lastFire = 0;
        lastArgs = undefined;
        lastCall = undefined;
        lastThis = undefined;
        timer = undefined;
    };
    wrapped.flush = function flush() {
        return timer === undefined ? lastResult : trailingEdge(now());
    };
    return wrapped;
}
//# sourceMappingURL=lodash.debounce.js.map