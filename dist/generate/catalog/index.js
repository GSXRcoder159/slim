/**
 * MIT License
 *
 * Catalog registry: map a package + used symbols to verified implementations.
 * Lodash ids are listed even if `lodash.ts` is produced by a sibling module.
 */
import { CATALOG_ORACLES, LODASH_PER_METHOD_ORACLES } from "./oracles.js";
import { canonicalLodashSymbol, lodashNpmName, LODASH_SYMBOLS, } from "./lodash-names.js";
import { createMoment, moment } from "./moment.js";
import { v4 } from "./uuid.js";
import { ms } from "./ms.js";
import { customAlphabet, nanoid } from "./nanoid.js";
import { clsx } from "./clsx.js";
import whatwgUrl, { URL, URLSearchParams } from "./whatwgUrl.js";
import Bluebird, { all, delay, Promise as BluebirdPromise, promisify, race, reject, resolve, } from "./bluebird.js";
import { extension, lookup } from "./mimeTypes.js";
import { assign, camelCase, chunk, clone, cloneDeep, compact, debounce, defaultTo, filter, flatten, get, groupBy, has, head, identity, isEmpty, isEqual, isNil, kebabCase, keys, last, map, noop, omit, once, pick, set, snakeCase, take, throttle, uniq, values, } from "./lodash.js";
const PKG_ALIAS = {
    "lodash-es": "lodash",
    underscore: "lodash",
    classnames: "clsx",
    "mime-db": "mime-types",
    mime: "mime-types",
    "url-parse": "whatwg-url",
};
const ENTRIES = [];
function add(pkg, symbol, impl, supports) {
    ENTRIES.push({
        id: `${pkg}.${symbol}`,
        pkg,
        symbol,
        impl,
        ...(supports ? { supports } : {}),
    });
}
add("moment", "default", moment, {
    tokens: ["YYYY", "MM", "DD", "HH", "mm", "ss", "SSS", "M", "D", "H", "m", "s", "A", "a"],
    methods: ["format", "unix", "valueOf", "toDate", "add", "subtract", "isValid"],
    locales: false,
});
add("moment", "moment", moment);
add("moment", "createMoment", createMoment);
add("uuid", "v4", v4, { random: true, version: 4 });
add("ms", "default", ms);
add("ms", "ms", ms);
add("nanoid", "nanoid", nanoid, { size: 21 });
add("nanoid", "customAlphabet", customAlphabet);
add("nanoid", "default", nanoid);
add("clsx", "clsx", clsx);
add("clsx", "default", clsx);
add("whatwg-url", "URL", URL);
add("whatwg-url", "URLSearchParams", URLSearchParams);
add("whatwg-url", "default", whatwgUrl);
add("bluebird", "resolve", resolve);
add("bluebird", "reject", reject);
add("bluebird", "all", all);
add("bluebird", "race", race);
add("bluebird", "delay", delay, { timer: "setTimeout-at-call-time" });
add("bluebird", "promisify", promisify);
add("bluebird", "Promise", BluebirdPromise);
add("bluebird", "default", Bluebird);
add("mime-types", "lookup", lookup);
add("mime-types", "extension", extension);
const LODASH_IMPL = {
    get,
    set,
    has,
    debounce,
    throttle,
    once,
    isEmpty,
    isNil,
    isEqual,
    pick,
    omit,
    clone,
    cloneDeep,
    map,
    filter,
    groupBy,
    uniq,
    compact,
    flatten,
    camelCase,
    kebabCase,
    snakeCase,
    identity,
    noop,
    defaultTo,
    chunk,
    take,
    head,
    first: head,
    last,
    keys,
    values,
    assign,
};
for (const [symbol, impl] of Object.entries(LODASH_IMPL)) {
    add("lodash", symbol, impl);
}
export function canonicalCatalogPkg(pkg) {
    if (PKG_ALIAS[pkg])
        return PKG_ALIAS[pkg];
    if (pkg.startsWith("lodash."))
        return "lodash";
    return pkg;
}
function canonicalPkg(pkg) {
    return canonicalCatalogPkg(pkg);
}
function lodashPerMethodSuffix(pkg) {
    if (pkg.startsWith("lodash."))
        return pkg.slice("lodash.".length);
    return undefined;
}
function lodashForcedSymbol(pkg) {
    const suffix = lodashPerMethodSuffix(pkg);
    if (suffix === undefined)
        return undefined;
    return canonicalLodashSymbol(suffix);
}
export function catalogSymbols(pkg) {
    const family = canonicalPkg(pkg);
    if (family === "lodash") {
        const suffix = lodashPerMethodSuffix(pkg);
        if (suffix !== undefined) {
            const forced = canonicalLodashSymbol(suffix);
            return forced ? [forced] : [];
        }
        return [...LODASH_SYMBOLS];
    }
    const seen = new Set();
    const out = [];
    for (const e of ENTRIES) {
        if (e.pkg === family && !seen.has(e.symbol)) {
            seen.add(e.symbol);
            out.push(e.symbol);
        }
    }
    return out;
}
export function getCatalog(pkg, symbol) {
    const family = canonicalPkg(pkg);
    if (family === "lodash") {
        const suffix = lodashPerMethodSuffix(pkg);
        if (suffix !== undefined && !canonicalLodashSymbol(suffix))
            return undefined;
        const wanted = lodashForcedSymbol(pkg) ?? canonicalLodashSymbol(symbol) ?? symbol;
        const canon = wanted === "first" ? "head" : wanted;
        if (!LODASH_SYMBOLS.includes(canon) && wanted !== "first") {
            return undefined;
        }
        const impl = LODASH_IMPL[wanted] ?? LODASH_IMPL[canon];
        if (typeof impl !== "function")
            return undefined;
        return {
            id: `lodash.${canon}`,
            pkg: "lodash",
            symbol: wanted,
            impl,
            supports: { family: "lodash" },
        };
    }
    return ENTRIES.find((e) => e.pkg === family && e.symbol === symbol);
}
export function matchCatalog(pkg, symbols) {
    const matched = [];
    const missing = [];
    const available = new Set(catalogSymbols(pkg));
    const forced = lodashForcedSymbol(pkg);
    for (const symbol of symbols) {
        const key = forced ?? symbol;
        if (available.has(key) || available.has(symbol)) {
            const entry = getCatalog(pkg, symbol);
            if (entry)
                matched.push(entry);
            else
                missing.push(symbol);
        }
        else {
            missing.push(symbol);
        }
    }
    return { matched, missing };
}
export function allCatalogEntries() {
    return ENTRIES.slice();
}
export { CATALOG_ORACLES, LODASH_PER_METHOD_ORACLES, LODASH_SYMBOLS, PKG_ALIAS as CATALOG_PKG_ALIAS, lodashNpmName };
//# sourceMappingURL=index.js.map