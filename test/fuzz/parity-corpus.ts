import type { HyrumFlags } from "../../src/envelope/types.ts";

export type ParityCase = {
  name: string;
  orig: Function;
  good: Function;
  bad: Function;
  args: unknown[];
  thisArg?: unknown;
  hyrum: Partial<HyrumFlags>;
  /** live: obligation cannot be reconstructed from SlimValue (named in the case). */
  standing?: "pair" | "live";
};

function momentLike(n: number) {
  return {
    valueOf() {
      return n;
    },
    format(p?: string) {
      return p ? `f:${n}` : String(n);
    },
  };
}

/** Known-good / known-bad substitution corpus. Rebuilds graphs each call so cases stay isolated. */
export function createParityCases(): ParityCase[] {
  const shared = { n: 1 };
  const cyclic: { n: number; self?: unknown } = { n: 1 };
  cyclic.self = cyclic;
  const nested = { n: 1 };
  const root = { nested };
  const proto = { p: true };
  const d = new Date("2020-01-02T00:00:00.000Z");
  const sym = Symbol.for("slim-parity-k");
  const mapObj = { n: 1 };
  const setObj = { n: 1 };

  return [
    {
      name: "args[0] === args[1]",
      orig(a: { n: number }, b: { n: number }) {
        if (a !== b) throw new Error("split");
        a.n += 1;
        return a;
      },
      good(a: { n: number }, b: { n: number }) {
        if (a !== b) throw new Error("split");
        a.n += 1;
        return a;
      },
      bad(a: { n: number }, b: { n: number }) {
        a.n += 1;
        return { n: a.n };
      },
      args: [shared, shared],
      hyrum: { sameReference: true, mutation: true },
    },
    {
      name: "args[0] === thisArg with cycle",
      orig(this: { n: number; self?: unknown }, x: { n: number; self?: unknown }) {
        if (this !== x || this.self !== this) throw new Error("split");
        this.n += 1;
        return this;
      },
      good(this: { n: number; self?: unknown }, x: { n: number; self?: unknown }) {
        if (this !== x || this.self !== this) throw new Error("split");
        this.n += 1;
        return this;
      },
      bad(this: { n: number; self?: unknown }, x: { n: number; self?: unknown }) {
        this.n += 1;
        return { n: x.n, self: { n: x.n } };
      },
      args: [cyclic],
      thisArg: cyclic,
      hyrum: { sameReference: true, mutation: true },
    },
    {
      name: "nested multi-path share",
      orig(a: { child: { n: number } }, b: { n: number }) {
        if (a.child !== b) throw new Error("split");
        return { wrapped: b };
      },
      good(a: { child: { n: number } }, b: { n: number }) {
        if (a.child !== b) throw new Error("split");
        return { wrapped: b };
      },
      bad(a: { child: { n: number } }, b: { n: number }) {
        return { wrapped: { n: b.n } };
      },
      args: [{ child: shared }, shared],
      hyrum: { sameReference: true },
    },
    {
      name: "nested input-to-result identity",
      orig(o: { n: number }) {
        return { wrapped: o };
      },
      good(o: { n: number }) {
        return { wrapped: o };
      },
      bad(o: { n: number }) {
        return { wrapped: { ...o } };
      },
      args: [{ n: 1 }],
      hyrum: { sameReference: true },
    },
    {
      name: "mutation through shared receiver",
      orig(this: { n: number }, x: { n: number }) {
        this.n += 1;
        return x.n;
      },
      good(this: { n: number }, x: { n: number }) {
        this.n += 1;
        return x.n;
      },
      bad(this: { n: number }, x: { n: number }) {
        return x.n + 1;
      },
      args: [shared],
      thisArg: shared,
      hyrum: { mutation: true },
    },
    {
      name: "constructor retry keeps aliased args",
      orig: class Pair {
        a: { n: number };
        b: { n: number };
        constructor(a: { n: number }, b: { n: number }) {
          if (new.target === undefined) {
            throw new TypeError("Class constructor Pair cannot be invoked without 'new'");
          }
          if (a !== b) throw new Error("split");
          this.a = a;
          this.b = b;
        }
      },
      good: class Pair {
        a: { n: number };
        b: { n: number };
        constructor(a: { n: number }, b: { n: number }) {
          if (new.target === undefined) {
            throw new TypeError("Class constructor Pair cannot be invoked without 'new'");
          }
          if (a !== b) throw new Error("split");
          this.a = a;
          this.b = b;
        }
      },
      bad: class Pair {
        a: { n: number };
        b: { n: number };
        constructor(a: { n: number }, b: { n: number }) {
          if (new.target === undefined) {
            throw new TypeError("Class constructor Pair cannot be invoked without 'new'");
          }
          this.a = { n: a.n };
          this.b = { n: b.n };
        }
      },
      args: [shared, shared],
      hyrum: { sameReference: true },
    },
    {
      name: "throw path keeps alias topology",
      orig(a: { n: number }, b: { n: number }) {
        a.n += 1;
        if (a !== b) throw new TypeError("split");
        throw new TypeError("nope");
      },
      good(a: { n: number }, b: { n: number }) {
        a.n += 1;
        if (a !== b) throw new TypeError("split");
        throw new TypeError("nope");
      },
      bad(a: { n: number }, b: { n: number }) {
        throw new TypeError("nope");
      },
      args: [shared, shared],
      hyrum: { mutation: true, errorMessage: true },
    },
    {
      name: "sameReference",
      orig: (o: { nested: { n: number } }) => o.nested,
      good: (o: { nested: { n: number } }) => o.nested,
      bad: (o: { nested: { n: number } }) => ({ ...o.nested }),
      args: [root],
      hyrum: { sameReference: true },
    },
    {
      name: "dateIdentity",
      orig: (x: Date) => x,
      good: (x: Date) => x,
      bad: (x: Date) => new Date(x.getTime()),
      args: [d],
      hyrum: { dateIdentity: true },
    },
    {
      name: "mutation",
      orig: (o: { n: number }) => {
        o.n += 1;
        return o.n;
      },
      good: (o: { n: number }) => {
        o.n += 1;
        return o.n;
      },
      bad: (o: { n: number }) => o.n + 1,
      args: [{ n: 0 }],
      hyrum: { mutation: true },
    },
    {
      name: "nan",
      orig: () => NaN,
      good: () => NaN,
      bad: () => 0,
      args: [],
      hyrum: { nan: true },
    },
    {
      name: "signedZero",
      orig: () => -0,
      good: () => -0,
      bad: () => 0,
      args: [],
      hyrum: { signedZero: true },
    },
    {
      name: "sparseArray",
      orig: () => {
        const a = new Array(3);
        a[1] = 1;
        return a;
      },
      good: () => {
        const a = new Array(3);
        a[1] = 1;
        return a;
      },
      bad: () => [undefined, 1, undefined],
      args: [],
      hyrum: { sparseArray: true },
    },
    {
      name: "keyOrder",
      orig: () => ({ x: 1, y: 2 }),
      good: () => ({ x: 1, y: 2 }),
      bad: () => ({ y: 2, x: 1 }),
      args: [],
      hyrum: { keyOrder: true },
    },
    {
      name: "errorMessage",
      orig: () => {
        throw new TypeError("Expected a function");
      },
      good: () => {
        throw new TypeError("Expected a function");
      },
      bad: () => {
        throw new TypeError("nope");
      },
      args: [],
      hyrum: { errorMessage: true },
    },
    {
      name: "prototype",
      orig: () => Object.assign(Object.create(proto), { x: 1 }),
      good: () => Object.assign(Object.create(proto), { x: 1 }),
      bad: () => Object.assign({}, { x: 1 }),
      args: [],
      hyrum: { prototype: true },
    },
    {
      name: "toString",
      orig: () => ({ x: 1, toString() { return "A"; } }),
      good: () => ({ x: 1, toString() { return "A"; } }),
      bad: () => ({ x: 1, toString() { return "B"; } }),
      args: [],
      hyrum: { toString: true },
    },
    {
      name: "json",
      orig: () => ({ x: 1, toJSON() { return { k: 1 }; } }),
      good: () => ({ x: 1, toJSON() { return { k: 1 }; } }),
      bad: () => ({ x: 1, toJSON() { return { k: 2 }; } }),
      args: [],
      hyrum: { json: true },
    },
    {
      name: "enumerable symbol keys",
      orig: () => ({ [sym]: 1, x: 2 }),
      good: () => ({ [sym]: 1, x: 2 }),
      bad: () => ({ x: 2 }),
      args: [],
      hyrum: {},
    },
    {
      name: "Map keyOrder",
      orig: () => new Map([["a", 1], ["b", 2]]),
      good: () => new Map([["a", 1], ["b", 2]]),
      bad: () => new Map([["b", 2], ["a", 1]]),
      args: [],
      hyrum: { keyOrder: true },
    },
    {
      name: "Set keyOrder",
      orig: () => new Set([1, 2, 3]),
      good: () => new Set([1, 2, 3]),
      bad: () => new Set([3, 1, 2]),
      args: [],
      hyrum: { keyOrder: true },
    },
    {
      name: "Map value aliases argument",
      orig: (o: { n: number }) => new Map([["k", o]]),
      good: (o: { n: number }) => new Map([["k", o]]),
      bad: (o: { n: number }) => new Map([["k", { ...o }]]),
      args: [mapObj],
      hyrum: { sameReference: true },
    },
    {
      name: "Set value aliases argument",
      orig: (o: { n: number }) => new Set([o]),
      good: (o: { n: number }) => new Set([o]),
      bad: (o: { n: number }) => new Set([{ ...o }]),
      args: [setObj],
      hyrum: { sameReference: true },
    },
    {
      name: "moment-like valueOf/format",
      orig: () => momentLike(1),
      good: () => momentLike(1),
      bad: () => momentLike(2),
      args: [],
      hyrum: {},
      /* frozen revive cannot reconstruct valueOf/format; live eq must still be moment-like. */
      standing: "live",
    },
  ];
}
