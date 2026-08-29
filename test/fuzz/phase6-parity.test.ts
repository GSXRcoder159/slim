import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyHyrum, type HyrumFlags } from "../../src/envelope/types.ts";
import { STANDING_RUNTIME } from "../../src/evidence/standing-equal.ts";
import { cloneInvocation } from "../../src/fuzz/clone.ts";
import { equalResults, invoke, normalizeError } from "../../src/fuzz/equal.ts";
import { createWalker } from "../../src/trace/serialize.ts";
import { createParityCases, type ParityCase } from "./parity-corpus.ts";

const standing = new Function(`${STANDING_RUNTIME}\nreturn { checkFrozenPair, standingEqual };`)() as {
  checkFrozenPair: (fn: Function, p: unknown) => void;
  standingEqual: (a: unknown, b: unknown, hyrum?: Partial<HyrumFlags>) => boolean;
};

export function freezePair(
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

export function runParityCase(c: ParityCase) {
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
  try {
    standing.checkFrozenPair(c.good, pair);
  } catch (e) {
    assert.fail(`${c.name}: standing good: ${e instanceof Error ? e.message : e}`);
  }
  try {
    standing.checkFrozenPair(c.bad, pair);
    assert.fail(`${c.name}: standing bad should reject`);
  } catch (e) {
    if (e instanceof assert.AssertionError) throw e;
  }
}

test("fuzz and standing accept and reject the same parity corpus", () => {
  for (const c of createParityCases()) runParityCase(c);
});
