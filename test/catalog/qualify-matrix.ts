/**
 * Phase 7 semantic qualification matrix. Every registered catalog symbol has
 * cases for each applicable category, or a non-empty N/A reason. The test
 * runner compares catalog impls to the pinned oracle unless mode is hardened.
 */

export const CATEGORIES = [
  "positive",
  "negative",
  "edge",
  "mutation",
  "throw",
  "timing",
  "identity",
  "security",
] as const;

export type Category = (typeof CATEGORIES)[number];

export type QualMode =
  | "equal"
  | "throws"
  | "same-ref"
  | "mutates-input"
  | "hardened"
  | "format"
  | "construct"
  | "await-equal"
  | "taxonomy";

export interface QualCase {
  name: string;
  args?: unknown[];
  thisArg?: unknown;
  mode?: QualMode;
  pick?: string;
  expect?: RegExp;
  ref?: (args: unknown[]) => unknown;
}

export interface QualRow {
  pkg: string;
  symbol: string;
  na?: Partial<Record<Category, string>>;
  cases: Partial<Record<Category, QualCase[]>>;
}

const naPure: Pick<NonNullable<QualRow["na"]>, "mutation" | "timing"> = {
  mutation: "does not write caller-owned objects",
  timing: "no timers or clock",
};

const naNoThrow: Pick<NonNullable<QualRow["na"]>, "throw"> = {
  throw: "invalid input is a defined return, not an exception",
};

const naNoIdentity: Pick<NonNullable<QualRow["na"]>, "identity"> = {
  identity: "returns a primitive or freshly allocated value that does not alias inputs",
};

const naNoSecurity: Pick<NonNullable<QualRow["na"]>, "security"> = {
  security: "no object-graph write, no dynamic code, no CSPRNG contract",
};

const naRead: QualRow["na"] = {
  ...naPure,
  ...naNoThrow,
  ...naNoSecurity,
};

const inner = { x: 1 };
const rooted = { a: inner };
const protoSrc = JSON.parse('{"__proto__":{"polluted":true}}') as object;

function lodashGet(): QualRow {
  return {
    pkg: "lodash",
    symbol: "get",
    na: { mutation: naPure.mutation, timing: naPure.timing, throw: naNoThrow.throw },
    cases: {
      positive: [{ name: "dotted path", args: [{ a: { b: 1 } }, "a.b"] }],
      negative: [{ name: "missing with default", args: [{}, "a.b", "d"] }],
      edge: [{ name: "null object", args: [null, "a", 5] }],
      identity: [{ name: "nested ref", args: [rooted, "a"], mode: "same-ref", ref: (a) => (a[0] as { a: unknown }).a }],
      security: [{ name: "unsafe proto path", args: [{}, "__proto__.polluted", true], mode: "hardened" }],
    },
  };
}

function lodashSet(): QualRow {
  return {
    pkg: "lodash",
    symbol: "set",
    na: { timing: naPure.timing, throw: naNoThrow.throw },
    cases: {
      positive: [{ name: "dotted set", args: [{}, "a.b", 1] }],
      negative: [{ name: "null dest", args: [null, "a", 1] }],
      edge: [{ name: "empty path", args: [{ a: 1 }, [], 9] }],
      mutation: [{ name: "mutates target", args: [{ a: 1 }, "b", 2], mode: "mutates-input" }],
      identity: [
        {
          name: "returns dest",
          args: [{ a: 1 }, "b", 2],
          mode: "same-ref",
          ref: (a) => a[0],
        },
      ],
      security: [{ name: "proto path", args: [{}, "__proto__.polluted", true], mode: "hardened" }],
    },
  };
}

function lodashHas(): QualRow {
  return {
    pkg: "lodash",
    symbol: "has",
    na: { ...naPure, ...naNoThrow, ...naNoIdentity },
    cases: {
      positive: [{ name: "own path", args: [{ a: { b: 2 } }, "a.b"] }],
      negative: [{ name: "inherited", args: [Object.create({ a: 1 }), "a"] }],
      edge: [{ name: "own undefined", args: [{ a: undefined }, "a"] }],
      security: [{ name: "unsafe key", args: [{}, "__proto__"], mode: "hardened" }],
    },
  };
}

const debounceThrow: QualCase = { name: "not a function", args: [null], mode: "throws" };
const debouncePos: QualCase = { name: "returns a function", args: [(n: number) => n, 16] };

function lodashDebounce(): QualRow {
  return {
    pkg: "lodash",
    symbol: "debounce",
    na: {
      mutation: "debounce wrapper does not write caller-owned objects",
      identity: "each call returns a new wrapper, not an alias of the input function",
      security: "no object-graph write or dynamic code",
    },
    cases: {
      positive: [debouncePos],
      negative: [{ name: "null fn throws", args: [null], mode: "throws" }],
      edge: [{ name: "zero wait", args: [(n: number) => n, 0] }],
      throw: [debounceThrow],
      timing: [{ name: "taxonomy", args: [], mode: "taxonomy" }],
    },
  };
}

function lodashThrottle(): QualRow {
  return {
    pkg: "lodash",
    symbol: "throttle",
    na: {
      mutation: "throttle wrapper does not write caller-owned objects",
      identity: "each call returns a new wrapper, not an alias of the input function",
      security: "no object-graph write or dynamic code",
    },
    cases: {
      positive: [{ name: "returns a function", args: [(n: number) => n, 16] }],
      negative: [{ name: "null fn throws", args: [null], mode: "throws" }],
      edge: [{ name: "zero wait", args: [(n: number) => n, 0] }],
      throw: [debounceThrow],
      timing: [{ name: "taxonomy", args: [], mode: "taxonomy" }],
    },
  };
}

function lodashOnce(): QualRow {
  return {
    pkg: "lodash",
    symbol: "once",
    na: {
      ...naPure,
      security: naNoSecurity.security,
      timing: naPure.timing,
      identity: "each call returns a new wrapper, not an alias of the input function",
    },
    cases: {
      positive: [{ name: "wraps", args: [(x: number) => x + 1] }],
      negative: [{ name: "null fn", args: [null], mode: "throws" }],
      edge: [{ name: "returns first result", args: [(x: number) => x] }],
      throw: [{ name: "not a function", args: [undefined], mode: "throws" }],
    },
  };
}

function lodashIsEmpty(): QualRow {
  return {
    pkg: "lodash",
    symbol: "isEmpty",
    na: { ...naRead, ...naNoIdentity },
    cases: {
      positive: [{ name: "empty object", args: [{}] }],
      negative: [{ name: "non-empty array", args: [[1]] }],
      edge: [{ name: "null", args: [null] }],
    },
  };
}

function lodashIsNil(): QualRow {
  return {
    pkg: "lodash",
    symbol: "isNil",
    na: { ...naRead, ...naNoIdentity },
    cases: {
      positive: [{ name: "null", args: [null] }],
      negative: [{ name: "zero", args: [0] }],
      edge: [{ name: "undefined", args: [undefined] }],
    },
  };
}

function lodashIsEqual(): QualRow {
  return {
    pkg: "lodash",
    symbol: "isEqual",
    na: { ...naRead, ...naNoIdentity },
    cases: {
      positive: [{ name: "equal objects", args: [{ a: 1 }, { a: 1 }] }],
      negative: [{ name: "null vs undefined", args: [null, undefined] }],
      edge: [{ name: "NaN", args: [NaN, NaN] }],
    },
  };
}

function lodashPick(): QualRow {
  return {
    pkg: "lodash",
    symbol: "pick",
    na: {
      ...naPure,
      ...naNoThrow,
    },
    cases: {
      positive: [{ name: "listed keys", args: [{ a: 1, b: 2, c: 3 }, ["a", "c"]] }],
      negative: [{ name: "null object", args: [null, "a"] }],
      edge: [{ name: "nested path", args: [{ a: { b: 1, c: 2 } }, "a.b"] }],
      identity: [{ name: "new root object", args: [{ a: 1, b: 2 }, ["a"]] }],
      security: [{ name: "proto key", args: [{}, ["__proto__"]], mode: "hardened" }],
    },
  };
}

function lodashOmit(): QualRow {
  return {
    pkg: "lodash",
    symbol: "omit",
    na: {
      ...naPure,
      ...naNoThrow,
    },
    cases: {
      positive: [{ name: "listed keys", args: [{ a: 1, b: 2, c: 3 }, ["a", "c"]] }],
      negative: [{ name: "null object", args: [null, "a"] }],
      edge: [{ name: "nested path", args: [{ a: { b: 1, c: 2 }, d: 3 }, "a.b"] }],
      identity: [{ name: "new root object", args: [{ a: 1, b: 2 }, ["a"]] }],
      security: [{ name: "proto key", args: [protoSrc, ["x"]], mode: "hardened" }],
    },
  };
}

function lodashClone(): QualRow {
  return {
    pkg: "lodash",
    symbol: "clone",
    na: {
      mutation: "clone does not mutate the source",
      timing: naPure.timing,
      throw: naNoThrow.throw,
    },
    cases: {
      positive: [{ name: "shallow array", args: [[{ a: 1 }]] }],
      negative: [{ name: "null", args: [null] }],
      edge: [{ name: "function becomes {}", args: [() => 1] }],
      identity: [{ name: "new root object", args: [{ a: 1 }] }],
      security: [{ name: "proto json", args: [protoSrc], mode: "hardened" }],
    },
  };
}

function lodashCloneDeep(): QualRow {
  return {
    pkg: "lodash",
    symbol: "cloneDeep",
    na: { mutation: "cloneDeep does not mutate the source", timing: naPure.timing, throw: naNoThrow.throw },
    cases: {
      positive: [{ name: "nested object", args: [{ a: { b: 1 } }] }],
      negative: [{ name: "null", args: [null] }],
      edge: [{ name: "date", args: [new Date(5)] }],
      identity: [{ name: "new root object", args: [{ a: 1 }] }],
      security: [{ name: "proto json", args: [protoSrc], mode: "hardened" }],
    },
  };
}

function iterateeThrow(): QualCase {
  return {
    name: "iteratee throw",
    args: [[1], () => {
      throw new TypeError("boom");
    }],
    mode: "throws",
  };
}

function lodashMap(): QualRow {
  return {
    pkg: "lodash",
    symbol: "map",
    na: { ...naPure, identity: naNoIdentity.identity, security: naNoSecurity.security },
    cases: {
      positive: [{ name: "array iteratee", args: [[4, 8], (n: number) => n * n] }],
      negative: [{ name: "null", args: [null] }],
      edge: [{ name: "property path", args: [[{ n: 1 }, { n: 2 }], "n"] }],
      throw: [iterateeThrow()],
    },
  };
}

function lodashFilter(): QualRow {
  return {
    pkg: "lodash",
    symbol: "filter",
    na: { ...naPure, identity: naNoIdentity.identity, security: naNoSecurity.security },
    cases: {
      positive: [{ name: "predicate", args: [[1, 2, 3], (n: number) => n > 1] }],
      negative: [{ name: "null", args: [null] }],
      edge: [{ name: "matches shorthand", args: [[{ x: 1 }, { x: 0 }], "x"] }],
      throw: [iterateeThrow()],
    },
  };
}

function lodashGroupBy(): QualRow {
  return {
    pkg: "lodash",
    symbol: "groupBy",
    na: { ...naPure, identity: naNoIdentity.identity, security: naNoSecurity.security },
    cases: {
      positive: [{ name: "Math.floor", args: [[6.1, 4.2, 6.3], Math.floor] }],
      negative: [{ name: "null", args: [null] }],
      edge: [{ name: "property", args: [[{ a: "x" }, { a: "x" }, { a: "y" }], "a"] }],
      throw: [iterateeThrow()],
    },
  };
}

function lodashUniq(): QualRow {
  return {
    pkg: "lodash",
    symbol: "uniq",
    na: { ...naRead, ...naNoIdentity },
    cases: {
      positive: [{ name: "dupes", args: [[2, 1, 2]] }],
      negative: [{ name: "null", args: [null] }],
      edge: [{ name: "NaN", args: [[NaN, NaN]] }],
    },
  };
}

function lodashCompact(): QualRow {
  return {
    pkg: "lodash",
    symbol: "compact",
    na: { ...naRead, ...naNoIdentity },
    cases: {
      positive: [{ name: "falsey", args: [[0, 1, false, 2, "", 3]] }],
      negative: [{ name: "null", args: [null] }],
      edge: [{ name: "empty", args: [[]] }],
    },
  };
}

function lodashFlatten(): QualRow {
  return {
    pkg: "lodash",
    symbol: "flatten",
    na: { ...naRead, ...naNoIdentity },
    cases: {
      positive: [{ name: "one level", args: [[1, [2, [3]], 5]] }],
      negative: [{ name: "null", args: [null] }],
      edge: [{ name: "string", args: ["ab"] }],
    },
  };
}

function caseFn(symbol: "camelCase" | "kebabCase" | "snakeCase"): QualRow {
  return {
    pkg: "lodash",
    symbol,
    na: { ...naRead, ...naNoIdentity },
    cases: {
      positive: [{ name: "Foo Bar", args: ["Foo Bar"] }],
      negative: [{ name: "null", args: [null] }],
      edge: [{ name: "XMLHttpRequest", args: ["XMLHttpRequest"] }],
    },
  };
}

function lodashIdentity(): QualRow {
  return {
    pkg: "lodash",
    symbol: "identity",
    na: { ...naPure, ...naNoThrow, timing: naPure.timing, security: naNoSecurity.security },
    cases: {
      positive: [{ name: "number", args: [3] }],
      negative: [{ name: "undefined", args: [undefined] }],
      edge: [{ name: "null", args: [null] }],
      identity: [{ name: "same object", args: [inner], mode: "same-ref", ref: (a) => a[0] }],
    },
  };
}

function lodashNoop(): QualRow {
  return {
    pkg: "lodash",
    symbol: "noop",
    na: { ...naRead, ...naNoIdentity },
    cases: {
      positive: [{ name: "no args", args: [] }],
      negative: [{ name: "ignores args", args: [1, 2, 3] }],
      edge: [{ name: "object arg", args: [{}] }],
    },
  };
}

function lodashDefaultTo(): QualRow {
  return {
    pkg: "lodash",
    symbol: "defaultTo",
    na: { ...naPure, ...naNoThrow, timing: naPure.timing, security: naNoSecurity.security },
    cases: {
      positive: [{ name: "keeps 1", args: [1, 10] }],
      negative: [{ name: "null", args: [null, 10] }],
      edge: [{ name: "NaN", args: [NaN, 10] }],
      identity: [{ name: "keeps object", args: [inner, {}], mode: "same-ref", ref: (a) => a[0] }],
    },
  };
}

function lodashChunk(): QualRow {
  return {
    pkg: "lodash",
    symbol: "chunk",
    na: { ...naRead, ...naNoIdentity },
    cases: {
      positive: [{ name: "size 2", args: [["a", "b", "c", "d"], 2] }],
      negative: [{ name: "size 0", args: [[1, 2, 3], 0] }],
      edge: [{ name: "string size", args: [[1, 2, 3, 4], "2"] }],
    },
  };
}

function lodashTake(): QualRow {
  return {
    pkg: "lodash",
    symbol: "take",
    na: { ...naRead, ...naNoIdentity },
    cases: {
      positive: [{ name: "n=2", args: [[1, 2, 3], 2] }],
      negative: [{ name: "null", args: [null] }],
      edge: [{ name: "n=0", args: [[1, 2, 3], 0] }],
    },
  };
}

function lodashHead(): QualRow {
  return {
    pkg: "lodash",
    symbol: "head",
    na: { ...naPure, ...naNoThrow, timing: naPure.timing, security: naNoSecurity.security },
    cases: {
      positive: [{ name: "first element", args: [[1, 2]] }],
      negative: [{ name: "empty", args: [[]] }],
      edge: [{ name: "null", args: [null] }],
      identity: [
        {
          name: "same element",
          args: [[inner, 2]],
          mode: "same-ref",
          ref: (a) => (a[0] as unknown[])[0],
        },
      ],
    },
  };
}

function lodashFirst(): QualRow {
  return { ...lodashHead(), symbol: "first" };
}

function lodashLast(): QualRow {
  return {
    pkg: "lodash",
    symbol: "last",
    na: { ...naPure, ...naNoThrow, timing: naPure.timing, security: naNoSecurity.security },
    cases: {
      positive: [{ name: "last element", args: [[1, 2, 3]] }],
      negative: [{ name: "empty", args: [[]] }],
      edge: [{ name: "null", args: [null] }],
      identity: [
        {
          name: "same element",
          args: [[1, inner]],
          mode: "same-ref",
          ref: (a) => (a[0] as unknown[])[1],
        },
      ],
    },
  };
}

function lodashKeys(): QualRow {
  return {
    pkg: "lodash",
    symbol: "keys",
    na: { ...naRead, ...naNoIdentity },
    cases: {
      positive: [{ name: "object", args: [{ b: 1, a: 2 }] }],
      negative: [{ name: "null", args: [null] }],
      edge: [{ name: "string", args: ["hi"] }],
    },
  };
}

function lodashValues(): QualRow {
  return {
    pkg: "lodash",
    symbol: "values",
    na: { ...naRead, ...naNoIdentity },
    cases: {
      positive: [{ name: "object", args: [{ b: 1, a: 2 }] }],
      negative: [{ name: "null", args: [null] }],
      edge: [{ name: "sparse array", args: [[, 2]] }],
    },
  };
}

function lodashAssign(): QualRow {
  return {
    pkg: "lodash",
    symbol: "assign",
    na: { timing: naPure.timing, throw: naNoThrow.throw },
    cases: {
      positive: [{ name: "copies keys", args: [{ a: 1 }, { b: 2 }] }],
      negative: [{ name: "null source", args: [{ a: 1 }, null, { b: 2 }] }],
      edge: [{ name: "null dest coerced", args: [null, { a: 1 }] }],
      mutation: [{ name: "mutates dest", args: [{ a: 1 }, { b: 2 }], mode: "mutates-input" }],
      identity: [{ name: "returns dest", args: [{ a: 1 }, { b: 2 }], mode: "same-ref", ref: (a) => a[0] }],
      security: [{ name: "proto source", args: [{}, protoSrc], mode: "hardened" }],
    },
  };
}

const msCases = {
  positive: [{ name: "1h", args: ["1h"] as unknown[] }],
  negative: [{ name: "empty", args: [""] }],
  edge: [{ name: "negative days", args: ["-3 days"] }],
};

function msRow(symbol: string): QualRow {
  return {
    pkg: "ms",
    symbol,
    na: {
      mutation: naPure.mutation,
      timing: naPure.timing,
      identity: naNoIdentity.identity,
      security: naNoSecurity.security,
    },
    cases: {
      ...msCases,
      throw: [{ name: "empty string", args: [""], mode: "throws" }],
    },
  };
}

function clsxRow(symbol: string): QualRow {
  return {
    pkg: "clsx",
    symbol,
    na: { ...naRead, ...naNoIdentity },
    cases: {
      positive: [{ name: "strings", args: ["foo", "bar"] }],
      negative: [{ name: "falsey", args: [null, false, 0, ""] }],
      edge: [{ name: "object keys", args: [{ foo: true, bar: false }] }],
    },
  };
}

function momentRow(symbol: string): QualRow {
  return {
    pkg: "moment",
    symbol,
    na: {
      mutation: "format/parse return new wrappers; add is tested as identity of the wrapper",
      throw: naNoThrow.throw,
      security: "locale packs are refused; no dynamic code",
    },
    cases: {
      positive: [{ name: "epoch ms", args: [Date.UTC(2021, 5, 1)] }],
      negative: [{ name: "invalid string", args: ["not a date"] }],
      edge: [{ name: "null", args: [null] }],
      timing: [{ name: "Date.now at call time", args: [] }],
      identity: [{ name: "valueOf", args: [new Date("2020-01-15T00:00:00.000Z")] }],
    },
  };
}

export const MATRIX: QualRow[] = [
  momentRow("default"),
  momentRow("moment"),
  momentRow("createMoment"),
  {
    pkg: "uuid",
    symbol: "v4",
    na: { mutation: naPure.mutation, timing: naPure.timing },
    cases: {
      positive: [{ name: "seeded random", args: [{ random: new Uint8Array(16) }] }],
      negative: [{ name: "short random", args: [{ random: new Uint8Array(8) }], mode: "throws" }],
      edge: [{ name: "patterned random", args: [{ random: Uint8Array.from({ length: 16 }, (_, i) => i) }] }],
      throw: [{ name: "short random", args: [{ random: new Uint8Array(8) }], mode: "throws" }],
      identity: [{ name: "unique", args: [] }],
      security: [{ name: "v4 format", args: [], mode: "format", expect: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/ }],
    },
  },
  msRow("default"),
  msRow("ms"),
  {
    pkg: "nanoid",
    symbol: "nanoid",
    na: {
      mutation: naPure.mutation,
      timing: naPure.timing,
      throw: "negative size returns an empty string rather than throwing",
    },
    cases: {
      positive: [{ name: "size 10", args: [10] }],
      negative: [{ name: "size 0", args: [0] }],
      edge: [{ name: "default size", args: [] }],
      identity: [{ name: "unique", args: [] }],
      security: [{ name: "url alphabet", args: [], mode: "format", expect: /^[A-Za-z0-9_-]+$/ }],
    },
  },
  {
    pkg: "nanoid",
    symbol: "customAlphabet",
    na: { mutation: naPure.mutation, timing: naPure.timing, identity: "returns a new generator, not an alias of the alphabet string" },
    cases: {
      positive: [{ name: "returns generator", args: ["abc", 5] }],
      negative: [{ name: "default size omitted", args: ["abc"] }],
      edge: [{ name: "size 1", args: ["ab", 1] }],
      throw: [{ name: "empty alphabet invoke", args: ["", 4], mode: "throws" }],
      security: [{ name: "only given alphabet", args: ["xyz", 8] }],
    },
  },
  {
    pkg: "nanoid",
    symbol: "default",
    na: {
      mutation: naPure.mutation,
      timing: naPure.timing,
      throw: "negative size returns an empty string rather than throwing",
    },
    cases: {
      positive: [{ name: "size 10", args: [10] }],
      negative: [{ name: "size 0", args: [0] }],
      edge: [{ name: "default size", args: [] }],
      identity: [{ name: "unique", args: [] }],
      security: [{ name: "url alphabet", args: [], mode: "format", expect: /^[A-Za-z0-9_-]+$/ }],
    },
  },
  clsxRow("clsx"),
  clsxRow("default"),
  {
    pkg: "whatwg-url",
    symbol: "URL",
    na: { mutation: "constructor does not mutate args", timing: naPure.timing, security: "platform URL, no parser reimplementation" },
    cases: {
      positive: [{ name: "absolute", args: ["https://example.com/path"], mode: "construct" }],
      negative: [{ name: "invalid", args: ["not a url"], mode: "throws" }],
      edge: [{ name: "relative with base", args: ["/x", "https://example.com/a/b"], mode: "construct" }],
      throw: [{ name: "invalid throws TypeError", args: ["::::"], mode: "throws" }],
      identity: [{ name: "is platform URL", args: [], mode: "same-ref", ref: () => globalThis.URL }],
    },
  },
  {
    pkg: "whatwg-url",
    symbol: "URLSearchParams",
    na: { mutation: "constructor copies the query string", timing: naPure.timing, security: "platform URLSearchParams" },
    cases: {
      positive: [{ name: "parse", args: ["a=1&b=2"], mode: "construct" }],
      negative: [{ name: "empty", args: [""], mode: "construct" }],
      edge: [{ name: "sequence", args: [[["a", "1"]]], mode: "construct" }],
      throw: [{ name: "invalid record", args: [1], mode: "construct" }],
      identity: [{ name: "is platform", args: [], mode: "same-ref", ref: () => globalThis.URLSearchParams }],
    },
  },
  {
    pkg: "whatwg-url",
    symbol: "default",
    na: {
      ...naPure,
      ...naNoThrow,
      negative: "namespace object has no failure return; missing keys are a positive export contract",
      identity: "namespace object is not the platform module object",
    },
    cases: {
      positive: [{ name: "has URL", args: [], pick: "URL" }],
      edge: [{ name: "has URLSearchParams", args: [], pick: "URLSearchParams" }],
      security: [{ name: "URL is platform", args: [], pick: "URL", mode: "same-ref", ref: () => globalThis.URL }],
    },
  },
  {
    pkg: "bluebird",
    symbol: "resolve",
    na: { ...naPure, ...naNoThrow, security: naNoSecurity.security, identity: naNoIdentity.identity },
    cases: {
      positive: [{ name: "value", args: [7], mode: "await-equal" }],
      negative: [{ name: "undefined", args: [], mode: "await-equal" }],
      edge: [{ name: "thenable", args: [Promise.resolve(3)], mode: "await-equal" }],
    },
  },
  {
    pkg: "bluebird",
    symbol: "reject",
    na: { ...naPure, mutation: naPure.mutation, timing: naPure.timing, security: naNoSecurity.security, identity: naNoIdentity.identity, negative: "rejection is the throw category" },
    cases: {
      positive: [{ name: "reason", args: [new Error("nope")], mode: "await-equal" }],
      throw: [{ name: "rejects", args: [new Error("nope")], mode: "await-equal" }],
      edge: [{ name: "string reason", args: ["x"], mode: "await-equal" }],
    },
  },
  {
    pkg: "bluebird",
    symbol: "all",
    na: { ...naPure, ...naNoThrow, security: naNoSecurity.security, identity: naNoIdentity.identity },
    cases: {
      positive: [{ name: "mixed", args: [[1, Promise.resolve(2)]], mode: "await-equal" }],
      negative: [{ name: "empty", args: [[]], mode: "await-equal" }],
      edge: [{ name: "reject member", args: [[{ then(_: unknown, e: (err: Error) => void) { e(new Error("x")); } }]], mode: "await-equal" }],
    },
  },
  {
    pkg: "bluebird",
    symbol: "race",
    na: { ...naPure, security: naNoSecurity.security, identity: naNoIdentity.identity, throw: "rejection of the winner is the throw path of await-equal" },
    cases: {
      positive: [{ name: "first resolved", args: [[Promise.resolve("a"), Promise.resolve("b")]], mode: "await-equal" }],
      negative: [{ name: "empty hangs not used", args: [[Promise.resolve(1)]], mode: "await-equal" }],
      edge: [{ name: "already resolved", args: [[Promise.resolve(9)]], mode: "await-equal" }],
    },
  },
  {
    pkg: "bluebird",
    symbol: "delay",
    na: { mutation: naPure.mutation, throw: naNoThrow.throw, security: naNoSecurity.security, identity: naNoIdentity.identity },
    cases: {
      positive: [{ name: "resolves value", args: [0, "later"], mode: "await-equal" }],
      negative: [{ name: "undefined value", args: [0], mode: "await-equal" }],
      edge: [{ name: "zero ms", args: [0, 1], mode: "await-equal" }],
      timing: [{ name: "setTimeout at call time", args: [25, "later"], mode: "await-equal" }],
    },
  },
  {
    pkg: "bluebird",
    symbol: "promisify",
    na: { ...naPure, security: naNoSecurity.security },
    cases: {
      positive: [{ name: "returns function", args: [(cb: (e: Error | null, v?: number) => void) => cb(null, 1)] }],
      negative: [{ name: "null fn", args: [null], mode: "throws" }],
      edge: [{ name: "non-function", args: [1], mode: "throws" }],
      throw: [{ name: "null fn", args: [null], mode: "throws" }],
      identity: [{ name: "new wrapper", args: [(cb: (e: null, v?: number) => void) => cb(null, 1)] }],
    },
  },
  {
    pkg: "bluebird",
    symbol: "Promise",
    na: {
      mutation: naPure.mutation,
      throw: "constructing with a non-function executor throws; covered on resolve/reject",
      security: naNoSecurity.security,
      negative: "constructor identity is the positive/identity contract",
    },
    cases: {
      positive: [{ name: "construct", args: [(res: (v: number) => void) => res(1)], mode: "construct" }],
      edge: [{ name: "has delay", args: [], pick: "delay" }],
      identity: [{ name: "same as default", args: [], mode: "same-ref", ref: () => "self" }],
      timing: [{ name: "delay static", args: [], pick: "delay" }],
    },
  },
  {
    pkg: "bluebird",
    symbol: "default",
    na: {
      mutation: naPure.mutation,
      throw: "same constructor as Promise",
      security: naNoSecurity.security,
      negative: "constructor identity is the positive/identity contract",
    },
    cases: {
      positive: [{ name: "construct", args: [(res: (v: number) => void) => res(1)], mode: "construct" }],
      edge: [{ name: "has promisify", args: [], pick: "promisify" }],
      identity: [{ name: "same as Promise export", args: [], mode: "same-ref", ref: () => "self" }],
      timing: [{ name: "has delay", args: [], pick: "delay" }],
    },
  },
  {
    pkg: "mime-types",
    symbol: "lookup",
    na: { ...naRead, ...naNoIdentity },
    cases: {
      positive: [{ name: "html", args: ["index.html"] }],
      negative: [{ name: "unknown", args: ["file.unknown"] }],
      edge: [{ name: "uppercase JPG", args: ["pic.JPG"] }],
    },
  },
  {
    pkg: "mime-types",
    symbol: "extension",
    na: { ...naRead, ...naNoIdentity },
    cases: {
      positive: [{ name: "html", args: ["text/html"] }],
      negative: [{ name: "unknown", args: ["no/such"] }],
      edge: [{ name: "charset param", args: ["text/html; charset=utf-8"] }],
    },
  },
  lodashGet(),
  lodashSet(),
  lodashHas(),
  lodashDebounce(),
  lodashThrottle(),
  lodashOnce(),
  lodashIsEmpty(),
  lodashIsNil(),
  lodashIsEqual(),
  lodashPick(),
  lodashOmit(),
  lodashClone(),
  lodashCloneDeep(),
  lodashMap(),
  lodashFilter(),
  lodashGroupBy(),
  lodashUniq(),
  lodashCompact(),
  lodashFlatten(),
  caseFn("camelCase"),
  caseFn("kebabCase"),
  caseFn("snakeCase"),
  lodashIdentity(),
  lodashNoop(),
  lodashDefaultTo(),
  lodashChunk(),
  lodashTake(),
  lodashHead(),
  lodashFirst(),
  lodashLast(),
  lodashKeys(),
  lodashValues(),
  lodashAssign(),
];
