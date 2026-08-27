import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyHyrum, type HyrumFlags } from "../../src/envelope/types.ts";
import { STANDING_RUNTIME } from "../../src/evidence/standing-equal.ts";
import { cloneInvocation } from "../../src/fuzz/clone.ts";
import { equalResults, invoke, normalizeError } from "../../src/fuzz/equal.ts";
import { createWalker } from "../../src/trace/serialize.ts";

const standing = new Function(`${STANDING_RUNTIME}\nreturn { checkFrozenPair, standingEqual };`)() as {
  checkFrozenPair: (fn: Function, p: unknown) => void;
  standingEqual: (a: unknown, b: unknown, hyrum?: Partial<HyrumFlags>) => boolean;
};

type Case = {
  name: string;
  orig: Function;
  good: Function;
  bad: Function;
  args: unknown[];
  thisArg?: unknown;
  hyrum: Partial<HyrumFlags>;
  standing?: "pair" | "live";
};

function freezePair(
  orig: Function,
  args: unknown[],
  thisArg: unknown,
  hyrum: Partial<HyrumFlags>,
  symbol: string,
) {
  const { args: liveArgs, thisArg: liveThis } = cloneInvocation(args, thisArg);
  const before = createWalker();
  const argsSv = liveArgs.map((a) => before.value(a));
  const thisSv =
    liveThis === undefined || liveThis === null ? null : before.value(liveThis);
  let threw: { name: string; message: string; code?: unknown } | null = null;
  let resultSv: unknown = null;
  try {
    resultSv = before.value(orig.apply(liveThis, liveArgs));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/without ['"]?new['"]?/i.test(msg) || /Class constructor/i.test(msg)) {
      try {
        resultSv = before.value(Reflect.construct(orig, liveArgs));
      } catch (e2) {
        threw = normalizeError(e2);
      }
    } else {
      threw = normalizeError(e);
    }
  }
  const after = createWalker();
  return {
    symbol,
    args: argsSv,
    thisArg: thisSv,
    threw,
    result: threw ? null : resultSv,
    hyrum: { ...emptyHyrum(), ...hyrum },
    argsAfter: liveArgs.map((a) => after.value(a)),
    thisAfter:
      liveThis === undefined || liveThis === null ? null : after.value(liveThis),
  };
}

function assertStandingRejects(fn: Function, pair: unknown) {
  assert.throws(() => standing.checkFrozenPair(fn, pair));
}

function runCase(c: Case) {
  const fuzzGood = equalResults(invoke(c.orig, c.args, c.thisArg), invoke(c.good, c.args, c.thisArg), c.hyrum);
  const fuzzBad = equalResults(invoke(c.orig, c.args, c.thisArg), invoke(c.bad, c.args, c.thisArg), c.hyrum);
  assert.equal(fuzzGood.ok, true, `${c.name}: fuzz good`);
  assert.equal(fuzzBad.ok, false, `${c.name}: fuzz bad`);
  if (c.standing === "live") {
    const origOut = invoke(c.orig, c.args, c.thisArg);
    const goodOut = invoke(c.good, c.args, c.thisArg);
    const badOut = invoke(c.bad, c.args, c.thisArg);
    assert.equal(origOut.ok && goodOut.ok && standing.standingEqual(origOut.value, goodOut.value, c.hyrum), true, `${c.name}: standing live good`);
    assert.equal(badOut.ok && standing.standingEqual(origOut.ok ? origOut.value : null, badOut.value, c.hyrum), false, `${c.name}: standing live bad`);
    return;
  }
  const pair = freezePair(c.orig, c.args, c.thisArg, c.hyrum, "fn");
  standing.checkFrozenPair(c.good, pair);
  assertStandingRejects(c.bad, pair);
}

test("shared-graph alias gaps fail both fuzz and standing", () => {
  const shared = { n: 1 };
  const cyclic: { n: number; self?: unknown } = { n: 1 };
  cyclic.self = cyclic;

  const cases: Case[] = [
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
  ];

  for (const c of cases) runCase(c);
});

test("every Hyrum flag has a standing reject matching fuzz", () => {
  const nested = { n: 1 };
  const root = { nested };
  const proto = { p: true };
  const d = new Date("2020-01-02T00:00:00.000Z");
  const cases: Case[] = [
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
      standing: "live",
    },
    {
      name: "toString",
      orig: () => ({ x: 1, toString() { return "A"; } }),
      good: () => ({ x: 1, toString() { return "A"; } }),
      bad: () => ({ x: 1, toString() { return "B"; } }),
      args: [],
      hyrum: { toString: true },
      standing: "live",
    },
    {
      name: "json",
      orig: () => ({ x: 1, toJSON() { return { k: 1 }; } }),
      good: () => ({ x: 1, toJSON() { return { k: 1 }; } }),
      bad: () => ({ x: 1, toJSON() { return { k: 2 }; } }),
      args: [],
      hyrum: { json: true },
      standing: "live",
    },
  ];

  for (const c of cases) runCase(c);
});
