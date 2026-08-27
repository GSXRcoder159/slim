/**
 * MIT License
 *
 * Catalog registry: map a package + used symbols to verified implementations.
 * Lodash ids are listed even if `lodash.ts` is produced by a sibling module.
 */

import { CATALOG_ORACLES } from "./oracles.ts";
import { createMoment, moment } from "./moment.ts";
import { v4 } from "./uuid.ts";
import { ms } from "./ms.ts";
import { customAlphabet, nanoid } from "./nanoid.ts";
import { clsx } from "./clsx.ts";
import whatwgUrl, { URL, URLSearchParams } from "./whatwgUrl.ts";
import Bluebird, {
  all,
  delay,
  Promise as BluebirdPromise,
  promisify,
  race,
  reject,
  resolve,
} from "./bluebird.ts";
import { extension, lookup } from "./mimeTypes.ts";
import {
  assign,
  camelCase,
  chunk,
  clone,
  cloneDeep,
  compact,
  debounce,
  defaultTo,
  filter,
  flatten,
  get,
  groupBy,
  has,
  head,
  identity,
  isEmpty,
  isEqual,
  isNil,
  kebabCase,
  keys,
  last,
  map,
  noop,
  omit,
  once,
  pick,
  set,
  snakeCase,
  take,
  throttle,
  uniq,
  values,
} from "./lodash.ts";

export interface CatalogEntry {
  id: string;
  pkg: string;
  symbol: string;
  impl: Function;
  supports?: Record<string, unknown>;
}

const LODASH_SYMBOLS = [
  "get",
  "set",
  "has",
  "debounce",
  "throttle",
  "once",
  "isEmpty",
  "isNil",
  "isEqual",
  "pick",
  "omit",
  "clone",
  "cloneDeep",
  "map",
  "filter",
  "groupBy",
  "uniq",
  "compact",
  "flatten",
  "camelCase",
  "kebabCase",
  "snakeCase",
  "identity",
  "noop",
  "defaultTo",
  "chunk",
  "take",
  "head",
  "first",
  "last",
  "keys",
  "values",
  "assign",
] as const;

const PKG_ALIAS: Record<string, string> = {
  "lodash-es": "lodash",
  underscore: "lodash",
  classnames: "clsx",
  "mime-db": "mime-types",
  mime: "mime-types",
  "url-parse": "whatwg-url",
};

const ENTRIES: CatalogEntry[] = [];

function add(
  pkg: string,
  symbol: string,
  impl: Function,
  supports?: Record<string, unknown>,
): void {
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
add("whatwg-url", "default", whatwgUrl as unknown as Function);
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

const LODASH_IMPL: Record<string, Function> = {
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

export function canonicalCatalogPkg(pkg: string): string {
  if (PKG_ALIAS[pkg]) return PKG_ALIAS[pkg];
  if (pkg.startsWith("lodash.")) return "lodash";
  return pkg;
}

function canonicalPkg(pkg: string): string {
  return canonicalCatalogPkg(pkg);
}

function lodashForcedSymbol(pkg: string): string | undefined {
  if (pkg.startsWith("lodash.")) return pkg.slice("lodash.".length);
  return undefined;
}

export function catalogSymbols(pkg: string): string[] {
  const family = canonicalPkg(pkg);
  if (family === "lodash") {
    const forced = lodashForcedSymbol(pkg);
    if (forced) return [forced];
    return [...LODASH_SYMBOLS];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of ENTRIES) {
    if (e.pkg === family && !seen.has(e.symbol)) {
      seen.add(e.symbol);
      out.push(e.symbol);
    }
  }
  return out;
}

export function getCatalog(pkg: string, symbol: string): CatalogEntry | undefined {
  const family = canonicalPkg(pkg);
  if (family === "lodash") {
    const wanted = lodashForcedSymbol(pkg) ?? symbol;
    const canon = wanted === "first" ? "head" : wanted;
    if (!LODASH_SYMBOLS.includes(canon as (typeof LODASH_SYMBOLS)[number]) && wanted !== "first") {
      return undefined;
    }
    const impl = LODASH_IMPL[wanted] ?? LODASH_IMPL[canon];
    if (typeof impl !== "function") return undefined;
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

export function matchCatalog(
  pkg: string,
  symbols: string[],
): { matched: CatalogEntry[]; missing: string[] } {
  const matched: CatalogEntry[] = [];
  const missing: string[] = [];
  const available = new Set(catalogSymbols(pkg));
  const forced = lodashForcedSymbol(pkg);
  for (const symbol of symbols) {
    const key = forced ?? symbol;
    if (available.has(key) || available.has(symbol)) {
      const entry = getCatalog(pkg, symbol);
      if (entry) matched.push(entry);
      else missing.push(symbol);
    } else {
      missing.push(symbol);
    }
  }
  return { matched, missing };
}

export function allCatalogEntries(): CatalogEntry[] {
  return ENTRIES.slice();
}

export { CATALOG_ORACLES, LODASH_SYMBOLS, PKG_ALIAS as CATALOG_PKG_ALIAS };
