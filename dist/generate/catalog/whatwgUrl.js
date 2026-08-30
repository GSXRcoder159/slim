/**
 * MIT License
 *
 * Drop-in for the common whatwg-url import surface: the platform `URL` and
 * `URLSearchParams`. Slim does not reimplement the WHATWG URL parser.
 */
export const URL = globalThis.URL;
export const URLSearchParams = globalThis.URLSearchParams;
const whatwgUrl = { URL, URLSearchParams };
export default whatwgUrl;
//# sourceMappingURL=whatwgUrl.js.map