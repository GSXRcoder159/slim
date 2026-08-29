/**
 * Mini consumers for packed catalog E2E. Generated so we do not check in
 * 33 lodash.* fixture directories.
 */

import { LODASH_SYMBOLS } from "../../src/generate/catalog/index.ts";
import { lodashNpmName } from "../../src/generate/catalog/index.ts";

export function lodashAllSymbolsSource(): { index: string; test: string } {
  const index = `import _ from "lodash";

export function pickUser(user: { profile?: { name?: string | null } } | null): string {
  return _.get(user, "profile.name", "anonymous") as string;
}

export function writePath(obj: Record<string, unknown>): unknown {
  return _.set(obj, "b", 2);
}

export function owns(obj: object, path: string): boolean {
  return _.has(obj, path);
}

export const ping = _.debounce((n: number) => n, 20);
export function schedule(fn: () => void): ReturnType<typeof _.debounce> {
  return _.debounce(fn, 15);
}
export function badDebounce(): ReturnType<typeof _.debounce> {
  return _.debounce(null as never, 10);
}

export const tick = _.throttle((n: number) => n, 20);
export const onceInc = _.once((n: number) => n + 1);

export function flags(v: unknown): boolean[] {
  return [_.isEmpty(v), _.isNil(v), _.isEqual(v, v)];
}

export function pickOmit(obj: { a: number; b: number; c: number }): unknown[] {
  return [_.pick(obj, ["a", "c"]), _.omit(obj, ["a"])];
}

export function copies(obj: { a: { b: number } }): unknown[] {
  return [_.clone(obj), _.cloneDeep(obj)];
}

export function collections(items: number[]): unknown[] {
  return [
    _.map(items, (n) => n * 2),
    _.filter(items, (n) => n > 1),
    _.groupBy(items, (n) => n % 2),
    _.uniq([1, 1, 2]),
    _.compact([0, 1, false, 2]),
    _.flatten([1, [2, [3]]]),
  ];
}

export function cases(s: string): string[] {
  return [_.camelCase(s), _.kebabCase(s), _.snakeCase(s)];
}

export function misc(n: number, obj: { a: number }): unknown[] {
  return [_.identity(n), _.noop(), _.defaultTo(null, n), _.chunk([1, 2, 3, 4], 2), _.take([1, 2, 3], 2), _.head([1, 2]), _.first([1, 2]), _.last([1, 2, 3]), _.keys(obj), _.values(obj), _.assign({ a: 1 }, { b: 2 })];
}
`;

  const test = `import { test } from "node:test";
import assert from "node:assert/strict";
import {
  badDebounce,
  cases,
  collections,
  copies,
  flags,
  misc,
  owns,
  onceInc,
  pickOmit,
  pickUser,
  ping,
  schedule,
  tick,
  writePath,
} from "./index.ts";

test("get default only when undefined", () => {
  assert.equal(pickUser({ profile: { name: "Ada" } }), "Ada");
  assert.equal(pickUser({}), "anonymous");
});

test("set has clone collections cases misc", () => {
  assert.deepEqual(writePath({ a: 1 }), { a: 1, b: 2 });
  assert.equal(owns({ a: 1 }, "a"), true);
  assert.deepEqual(flags({}), [true, false, true]);
  assert.deepEqual(pickOmit({ a: 1, b: 2, c: 3 }), [{ a: 1, c: 3 }, { b: 2, c: 3 }]);
  const nested = { a: { b: 1 } };
  const [shallow, deep] = copies(nested) as [{ a: { b: number } }, { a: { b: number } }];
  assert.equal(shallow.a, nested.a);
  assert.notEqual(deep.a, nested.a);
  assert.deepEqual(collections([1, 2, 3])[0], [2, 4, 6]);
  assert.deepEqual(cases("Foo Bar"), ["fooBar", "foo-bar", "foo_bar"]);
  assert.equal(onceInc(1), 2);
  assert.equal(onceInc(9), 2);
  assert.ok(Array.isArray(misc(3, { a: 1 })));
});

test("debounce and throttle are functions", async () => {
  assert.equal(typeof ping, "function");
  assert.equal(typeof tick, "function");
  ping(1);
  tick(1);
  await new Promise((r) => setTimeout(r, 40));
  ping.cancel();
  tick.cancel();
  let n = 0;
  const d = schedule(() => {
    n++;
  });
  d();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(n, 1);
  d.cancel();
});

test("debounce TypeError Expected a function", () => {
  assert.throws(() => badDebounce(), { name: "TypeError", message: "Expected a function" });
});
`;
  return { index, test };
}

export function lodashMethodConsumer(symbol: (typeof LODASH_SYMBOLS)[number]): {
  pkg: string;
  index: string;
  test: string;
} {
  const pkg = lodashNpmName(symbol);
  const snippets: Record<string, { index: string; test: string }> = {
    get: {
      index: `import get from "${pkg}";
export function pickUser(user: { profile?: { name?: string | null } } | null): string {
  return get(user, "profile.name", "anonymous") as string;
}
`,
      test: callTest("pickUser", `assert.equal(pickUser({ profile: { name: "Ada" } }), "Ada");\n  assert.equal(pickUser({}), "anonymous");`),
    },
    set: {
      index: `import set from "${pkg}";
export function writePath(): unknown {
  return set({ a: 1 }, "b", 2);
}
`,
      test: callTest("writePath", `assert.deepEqual(writePath(), { a: 1, b: 2 });`),
    },
    has: {
      index: `import has from "${pkg}";
export function owns(): boolean {
  return has({ a: { b: 1 } }, "a.b");
}
`,
      test: callTest("owns", `assert.equal(owns(), true);`),
    },
    debounce: {
      index: `import debounce from "${pkg}";
export const ping = debounce((n: number) => n, 20);
export function schedule(fn: () => void): ReturnType<typeof debounce> {
  return debounce(fn, 15);
}
`,
      test: `import { test } from "node:test";
import assert from "node:assert/strict";
import { ping, schedule } from "./index.ts";

test("debounce trailing invoke", async () => {
  assert.equal(typeof ping, "function");
  ping(1);
  let n = 0;
  const d = schedule(() => {
    n++;
  });
  d();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(n, 1);
  ping.cancel();
  d.cancel();
});
`,
    },
    throttle: {
      index: `import throttle from "${pkg}";
export const tick = throttle((n: number) => n, 20);
`,
      test: `import { test } from "node:test";
import assert from "node:assert/strict";
import { tick } from "./index.ts";

test("throttle is a function", async () => {
  assert.equal(typeof tick, "function");
  tick(1);
  await new Promise((r) => setTimeout(r, 30));
  tick.cancel();
});
`,
    },
    once: {
      index: `import once from "${pkg}";
export const inc = once((n: number) => n + 1);
`,
      test: callTest("inc", `assert.equal(inc(1), 2);\n  assert.equal(inc(9), 2);`, "inc"),
    },
    isEmpty: {
      index: `import isEmpty from "${pkg}";
export function empty(v: unknown): boolean {
  return isEmpty(v);
}
`,
      test: callTest("empty", `assert.equal(empty({}), true);\n  assert.equal(empty([1]), false);`),
    },
    isNil: {
      index: `import isNil from "${pkg}";
export function nil(v: unknown): boolean {
  return isNil(v);
}
`,
      test: callTest("nil", `assert.equal(nil(null), true);\n  assert.equal(nil(0), false);`),
    },
    isEqual: {
      index: `import isEqual from "${pkg}";
export function eq(a: unknown, b: unknown): boolean {
  return isEqual(a, b);
}
`,
      test: callTest("eq", `assert.equal(eq({ a: 1 }, { a: 1 }), true);\n  assert.equal(eq(1, 2), false);`),
    },
    pick: {
      index: `import pick from "${pkg}";
export function take(): unknown {
  return pick({ a: 1, b: 2, c: 3 }, ["a", "c"]);
}
`,
      test: callTest("take", `assert.deepEqual(take(), { a: 1, c: 3 });`),
    },
    omit: {
      index: `import omit from "${pkg}";
export function drop(): unknown {
  return omit({ a: 1, b: 2, c: 3 }, ["a"]);
}
`,
      test: callTest("drop", `assert.deepEqual(drop(), { b: 2, c: 3 });`),
    },
    clone: {
      index: `import clone from "${pkg}";
export function copy(): unknown {
  return clone({ a: 1 });
}
`,
      test: callTest("copy", `assert.deepEqual(copy(), { a: 1 });`),
    },
    cloneDeep: {
      index: `import cloneDeep from "${pkg}";
export function copy(): unknown {
  return cloneDeep({ a: { b: 1 } });
}
`,
      test: callTest("copy", `assert.deepEqual(copy(), { a: { b: 1 } });`),
    },
    map: {
      index: `import map from "${pkg}";
export function twice(items: number[]): number[] {
  return map(items, (n: number) => n * 2) as number[];
}
`,
      test: callTest("twice", `assert.deepEqual(twice([1, 2]), [2, 4]);`),
    },
    filter: {
      index: `import filter from "${pkg}";
export function gt(items: number[]): number[] {
  return filter(items, (n: number) => n > 1) as number[];
}
`,
      test: callTest("gt", `assert.deepEqual(gt([1, 2, 3]), [2, 3]);`),
    },
    groupBy: {
      index: `import groupBy from "${pkg}";
export function groups(items: number[]): unknown {
  return groupBy(items, (n: number) => n % 2);
}
`,
      test: callTest("groups", `assert.ok(groups([1, 2, 3]));`),
    },
    uniq: {
      index: `import uniq from "${pkg}";
export function unique(items: number[]): number[] {
  return uniq(items) as number[];
}
`,
      test: callTest("unique", `assert.deepEqual(unique([1, 1, 2]), [1, 2]);`),
    },
    compact: {
      index: `import compact from "${pkg}";
export function truthy(): unknown[] {
  return compact([0, 1, false, 2]) as unknown[];
}
`,
      test: callTest("truthy", `assert.deepEqual(truthy(), [1, 2]);`),
    },
    flatten: {
      index: `import flatten from "${pkg}";
export function flat(): unknown[] {
  return flatten([1, [2, [3]]]) as unknown[];
}
`,
      test: callTest("flat", `assert.deepEqual(flat(), [1, 2, [3]]);`),
    },
    camelCase: {
      index: `import camelCase from "${pkg}";
export function camel(s: string): string {
  return camelCase(s);
}
`,
      test: callTest("camel", `assert.equal(camel("Foo Bar"), "fooBar");`),
    },
    kebabCase: {
      index: `import kebabCase from "${pkg}";
export function kebab(s: string): string {
  return kebabCase(s);
}
`,
      test: callTest("kebab", `assert.equal(kebab("Foo Bar"), "foo-bar");`),
    },
    snakeCase: {
      index: `import snakeCase from "${pkg}";
export function snake(s: string): string {
  return snakeCase(s);
}
`,
      test: callTest("snake", `assert.equal(snake("Foo Bar"), "foo_bar");`),
    },
    identity: {
      index: `import identity from "${pkg}";
export function same<T>(v: T): T {
  return identity(v);
}
`,
      test: callTest("same", `assert.equal(same(3), 3);`),
    },
    noop: {
      index: `import noop from "${pkg}";
export function nada(): unknown {
  return noop();
}
`,
      test: callTest("nada", `assert.equal(nada(), undefined);`),
    },
    defaultTo: {
      index: `import defaultTo from "${pkg}";
export function fallback(v: unknown, d: number): number {
  return defaultTo(v, d) as number;
}
`,
      test: callTest("fallback", `assert.equal(fallback(null, 10), 10);\n  assert.equal(fallback(1, 10), 1);`),
    },
    chunk: {
      index: `import chunk from "${pkg}";
export function pairs(): unknown[][] {
  return chunk(["a", "b", "c", "d"], 2) as unknown[][];
}
`,
      test: callTest("pairs", `assert.deepEqual(pairs(), [["a", "b"], ["c", "d"]]);`),
    },
    take: {
      index: `import take from "${pkg}";
export function firstTwo(): number[] {
  return take([1, 2, 3], 2) as number[];
}
`,
      test: callTest("firstTwo", `assert.deepEqual(firstTwo(), [1, 2]);`),
    },
    head: {
      index: `import head from "${pkg}";
export function first(items: number[]): unknown {
  return head(items);
}
`,
      test: callTest("first", `assert.equal(first([1, 2]), 1);`),
    },
    first: {
      index: `import first from "${pkg}";
export function firstItem(items: number[]): unknown {
  return first(items);
}
`,
      test: callTest("firstItem", `assert.equal(firstItem([1, 2]), 1);`),
    },
    last: {
      index: `import last from "${pkg}";
export function lastItem(items: number[]): unknown {
  return last(items);
}
`,
      test: callTest("lastItem", `assert.equal(lastItem([1, 2, 3]), 3);`),
    },
    keys: {
      index: `import keys from "${pkg}";
export function names(): string[] {
  return keys({ b: 1, a: 2 }) as string[];
}
`,
      test: callTest("names", `assert.ok(names().includes("a"));`),
    },
    values: {
      index: `import values from "${pkg}";
export function vals(): unknown[] {
  return values({ a: 1, b: 2 }) as unknown[];
}
`,
      test: callTest("vals", `assert.ok(vals().includes(1));`),
    },
    assign: {
      index: `import assign from "${pkg}";
export function merge(): object {
  return assign({ a: 1 }, { b: 2 });
}
`,
      test: callTest("merge", `assert.deepEqual(merge(), { a: 1, b: 2 });`),
    },
  };
  const got = snippets[symbol];
  if (!got) throw new Error(`missing packed consumer for ${symbol}`);
  return { pkg, ...got };
}

function callTest(fn: string, body: string, importName = fn): string {
  return `import { test } from "node:test";
import assert from "node:assert/strict";
import { ${importName} } from "./index.ts";

test("${fn} works", () => {
  ${body}
});
`;
}
