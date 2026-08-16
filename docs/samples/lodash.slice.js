// src/slim/lodash.js
// Slice of lodash@4.17.21 for this repo. Evidence: lodash.evidence.md
// License: MIT (lodash). See lodash.LICENSE.
//
// Implements: get(object, path), debounce(fn, wait) trailing-only.
// Throws on path segments __proto__, constructor, prototype.

const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);

function toSegments(path) {
  if (typeof path !== "string") {
    throw new TypeError("slim lodash.get: path must be a string");
  }
  const segments = path.split(".").filter((s) => s.length > 0);
  for (const s of segments) {
    if (FORBIDDEN.has(s)) {
      throw new Error("slim lodash.get: refused path segment " + s);
    }
  }
  return segments;
}

export function get(object, path, defaultValue) {
  if (object == null) return defaultValue;
  const segments = toSegments(path);
  let cur = object;
  for (const key of segments) {
    if (cur == null || typeof cur !== "object") return defaultValue;
    if (!Object.hasOwn(cur, key) && !(key in cur)) return defaultValue;
    cur = cur[key];
  }
  return cur === undefined ? defaultValue : cur;
}

export function debounce(fn, wait) {
  if (typeof fn !== "function") {
    throw new TypeError("slim lodash.debounce: expected a function");
  }
  const delay = Number(wait) || 0;
  let timer = null;
  let lastArgs;
  let lastThis;
  function invoke() {
    timer = null;
    fn.apply(lastThis, lastArgs);
  }
  function debounced(...args) {
    lastArgs = args;
    lastThis = this;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(invoke, delay);
  }
  debounced.cancel = function cancel() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  debounced.flush = function flush() {
    if (timer !== null) {
      clearTimeout(timer);
      invoke();
    }
  };
  return debounced;
}

const api = { get, debounce };
export default api;
