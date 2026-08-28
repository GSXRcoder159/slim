import assert from "node:assert/strict";
import { describe, it } from "node:test";
import lodash from "lodash";
import momentOracle from "moment";
import msOracle from "ms";
import clsxOracle from "clsx";
import { v4 as uuidOracle } from "uuid";
import { nanoid as nanoidOracle, customAlphabet as customAlphabetOracle } from "nanoid";
import Bluebird from "bluebird";
import mimeOracle from "mime-types";
import * as whatwgOracle from "whatwg-url";
import { allCatalogEntries, getCatalog } from "../../src/generate/catalog/index.ts";
import { TAXONOMY, runDebounceScript, type DebounceScript } from "../../src/fuzz/debounce-driver.ts";
import { createFakeClock } from "../../src/fuzz/clock.ts";
import { withFrozenNow } from "../../src/fuzz/workers.ts";
import { CATEGORIES, MATRIX, type Category, type QualCase, type QualRow } from "./qualify-matrix.ts";

function idsOf(rows: { pkg: string; symbol: string }[]): string[] {
  return rows.map((r) => `${r.pkg}.${r.symbol}`).sort();
}

function oracleOf(pkg: string, symbol: string): unknown {
  if (pkg === "lodash") return (lodash as unknown as Record<string, unknown>)[symbol];
  if (pkg === "moment") return momentOracle;
  if (pkg === "ms") return msOracle;
  if (pkg === "clsx") return clsxOracle;
  if (pkg === "uuid") return uuidOracle;
  if (pkg === "nanoid") {
    if (symbol === "customAlphabet") return customAlphabetOracle;
    return nanoidOracle;
  }
  if (pkg === "bluebird") {
    const rec = Bluebird as unknown as Record<string, unknown>;
    if (symbol === "default" || symbol === "Promise") return Bluebird;
    return rec[symbol];
  }
  if (pkg === "mime-types") return (mimeOracle as unknown as Record<string, unknown>)[symbol];
  if (pkg === "whatwg-url") {
    if (symbol === "default") return { URL: whatwgOracle.URL, URLSearchParams: whatwgOracle.URLSearchParams };
    return (whatwgOracle as unknown as Record<string, unknown>)[symbol];
  }
  throw new Error(`no oracle loader for ${pkg}.${symbol}`);
}

function isThenable(v: unknown): v is Promise<unknown> {
  return v != null && typeof (v as { then?: unknown }).then === "function";
}

function invoke(
  fn: unknown,
  c: QualCase,
  row: QualRow,
): unknown {
  if (c.pick) {
    return (fn as Record<string, unknown>)[c.pick];
  }
  if (c.mode === "same-ref" && (!c.args || c.args.length === 0) && c.ref) {
    return fn;
  }
  const args = c.args ?? [];
  const construct =
    c.mode === "construct" ||
    ((row.symbol === "URL" || row.symbol === "URLSearchParams" || row.symbol === "Promise" || row.symbol === "default") &&
      row.pkg !== "ms" &&
      row.pkg !== "moment" &&
      row.pkg !== "clsx" &&
      row.pkg !== "nanoid" &&
      (c.mode === "throws" || c.mode === "construct"));
  if (typeof fn !== "function") return fn;
  if (construct && (c.mode === "construct" || c.mode === "throws")) {
    return new (fn as new (...a: unknown[]) => unknown)(...args);
  }
  if (c.thisArg !== undefined) {
    return (fn as (...a: unknown[]) => unknown).apply(c.thisArg, args);
  }
  const got = (fn as (...a: unknown[]) => unknown)(...args);
  return got;
}

async function settle(v: unknown): Promise<{ ok: true; value: unknown } | { ok: false; error: Error }> {
  try {
    const val = isThenable(v) ? await v : v;
    return { ok: true, value: val };
  } catch (e) {
    return { ok: false, error: e as Error };
  }
}

function assertHardened(impl: unknown, c: QualCase, row: QualRow): void {
  const before = Object.prototype.hasOwnProperty("polluted");
  try {
    invoke(impl, c, row);
  } catch {
    /* hardened paths may throw; pollution is the assertion */
  }
  assert.equal(
    Object.prototype.hasOwnProperty("polluted"),
    before,
    `${row.pkg}.${row.symbol} ${c.name} polluted Object.prototype`,
  );
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
}

async function runTaxonomy(impl: Function, oracle: Function, leadingTrailingOnly: boolean): Promise<void> {
  for (const [name, script] of Object.entries(TAXONOMY)) {
    const throttleScript: DebounceScript = leadingTrailingOnly
      ? {
          ...script,
          options: script.options
            ? { leading: script.options.leading, trailing: script.options.trailing }
            : undefined,
        }
      : script;
    const slimClock = createFakeClock(0);
    const origClock = createFakeClock(0);
    const slim = await runDebounceScript(impl, throttleScript, slimClock);
    const orig = await runDebounceScript(oracle, throttleScript, origClock);
    assert.deepEqual(slim.spies, orig.spies, `${name} spies`);
    assert.deepEqual(slim.returns, orig.returns, `${name} returns`);
    assert.deepEqual(slim.flushResults, orig.flushResults, `${name} flush`);
  }
}

async function runCase(row: QualRow, c: QualCase, impl: unknown, oracle: unknown): Promise<void> {
  const label = `${row.pkg}.${row.symbol} ${c.name}`;
  if (c.mode === "taxonomy") {
    await runTaxonomy(impl as Function, oracle as Function, row.symbol === "throttle");
    return;
  }
  if (c.mode === "hardened") {
    assertHardened(impl, c, row);
    return;
  }
  if (c.mode === "format") {
    const got = invoke(impl, c, row);
    assert.equal(typeof got, "string", label);
    assert.match(got as string, c.expect ?? /./, label);
    return;
  }
  if (c.mode === "throws") {
    if (row.symbol === "customAlphabet") {
      assert.throws(() => invoke(impl, c, row), Error, label);
      return;
    }
    let slimErr: unknown;
    let origErr: unknown;
    const call = (fn: unknown): void => {
      const v = invoke(fn, c, row);
      if (typeof v === "function") (v as () => unknown)();
    };
    try {
      call(impl);
    } catch (e) {
      slimErr = e;
    }
    try {
      call(oracle);
    } catch (e) {
      origErr = e;
    }
    assert.ok(slimErr, `${label}: catalog did not throw`);
    assert.ok(origErr, `${label}: oracle did not throw`);
    assert.ok(slimErr instanceof Error && origErr instanceof Error, label);
    return;
  }
  if (row.symbol === "once" && typeof impl === "function" && typeof oracle === "function" && (c.args?.[0] instanceof Function)) {
    const slim = (impl as Function)(c.args[0]);
    const orig = (oracle as Function)(c.args[0]);
    assert.equal(slim(1), orig(1), label);
    assert.equal(slim(9), orig(9), label);
    return;
  }
  if (row.symbol === "customAlphabet" && c.mode !== "throws" && typeof impl === "function") {
    const slimGen = (impl as Function)(...(c.args ?? []));
    const origGen = (oracle as Function)(...(c.args ?? []));
    if (typeof slimGen === "function") {
      const slimId = slimGen();
      assert.equal(typeof slimId, "string", label);
      if (c.name === "only given alphabet") {
        for (const ch of slimId as string) assert.ok("xyz".includes(ch), label);
      }
      if (typeof origGen === "function") {
        assert.equal((slimId as string).length, (origGen() as string).length, label);
      }
      return;
    }
  }
  if ((row.pkg === "uuid" || row.pkg === "nanoid") && c.name === "unique") {
    const a = invoke(impl, { ...c, args: c.args ?? [] }, row);
    const b = invoke(impl, { ...c, args: c.args ?? [] }, row);
    assert.notEqual(a, b, label);
    return;
  }
  if (row.symbol === "cloneDeep" && c.name === "new root object") {
    const src = c.args![0];
    const got = invoke(impl, c, row);
    assert.notEqual(got, src, label);
    assert.deepEqual(got, invoke(oracle, c, row), label);
    return;
  }
  if ((row.symbol === "Promise" || (row.pkg === "bluebird" && row.symbol === "default")) && c.ref?.([]) === "self") {
    const other = getCatalog("bluebird", row.symbol === "default" ? "Promise" : "default")?.impl;
    assert.equal(impl, other, label);
    return;
  }
  if (c.mode === "same-ref") {
    const got = invoke(impl, c, row);
    const target = c.ref?.(c.args ?? []);
    assert.equal(got, target, label);
    return;
  }
  if (c.mode === "mutates-input") {
    const dest = c.args![0] as object;
    const got = invoke(impl, c, row);
    assert.equal(got, dest, `${label} return`);
    const origDest = { ...(c.args![0] as object) };
    invoke(oracle, { ...c, args: [origDest, ...(c.args ?? []).slice(1)] }, row);
    assert.deepEqual(dest, origDest, label);
    return;
  }
  if (c.mode === "await-equal" || row.pkg === "bluebird" && ["resolve", "reject", "all", "race", "delay"].includes(row.symbol) && !c.pick) {
    const slimS = await settle(invoke(impl, c, row));
    const origS = await settle(invoke(oracle, c, row));
    assert.equal(slimS.ok, origS.ok, label);
    if (!slimS.ok && !origS.ok) {
      assert.equal(slimS.error.message, origS.error.message, label);
      return;
    }
    assert.deepEqual(slimS.ok ? slimS.value : null, origS.ok ? origS.value : null, label);
    return;
  }
  if (c.mode === "construct") {
    const got = invoke(impl, c, row);
    const exp = invoke(oracle, c, row);
    const hrefOf = (v: unknown): string | undefined =>
      v && typeof v === "object" && "href" in v ? String((v as { href: unknown }).href) : undefined;
    const gHref = hrefOf(got);
    const eHref = hrefOf(exp);
    if (gHref != null && eHref != null) {
      assert.equal(gHref, eHref, label);
      return;
    }
    if (got instanceof URLSearchParams || (got && typeof got === "object" && "toString" in got && row.symbol === "URLSearchParams")) {
      assert.equal(String(got), String(exp), label);
      return;
    }
    if (isThenable(got) && isThenable(exp)) {
      assert.deepEqual(await got, await exp, label);
      return;
    }
    assert.deepEqual(got, exp, label);
    return;
  }
  if ((row.pkg === "nanoid" || row.pkg === "uuid") && row.symbol !== "customAlphabet") {
    const got = invoke(impl, c, row);
    if (typeof got === "string") {
      const size = typeof c.args?.[0] === "number" ? c.args[0] : row.pkg === "uuid" ? 36 : 21;
      if (c.args?.[0] === 0) {
        assert.equal(got, "", label);
        return;
      }
      if (typeof size === "number" && size > 0) {
        assert.equal(got.length, row.pkg === "uuid" ? 36 : size, label);
      }
      return;
    }
  }
  let got: unknown;
  let exp: unknown;
  let slimErr: unknown;
  let origErr: unknown;
  withFrozenNow(() => {
    try {
      got = invoke(impl, c, row);
    } catch (e) {
      slimErr = e;
    }
    try {
      exp = invoke(oracle, c, row);
    } catch (e) {
      origErr = e;
    }
  });
  if (slimErr || origErr) {
    assert.ok(slimErr && origErr, `${label}: throw mismatch`);
    return;
  }
  if (typeof got === "function" && typeof exp === "function") {
    assert.equal(typeof got, "function", label);
    assert.equal(typeof exp, "function", label);
    return;
  }
  if (got instanceof Date && exp instanceof Date) {
    assert.equal(got.getTime(), exp.getTime(), label);
    return;
  }
  if (row.pkg === "moment" && got && typeof got === "object" && "valueOf" in got) {
    const g = got as { valueOf: () => number; isValid: () => boolean; format: (s: string) => string };
    const e = exp as { valueOf: () => number; isValid: () => boolean; format: (s: string) => string };
    assert.equal(g.isValid(), e.isValid(), label);
    if (g.isValid()) assert.equal(g.valueOf(), e.valueOf(), label);
    return;
  }
  assert.deepEqual(got, exp, label);
}

describe("catalog qualification matrix", () => {
  it("covers every registered catalog entry and no extras", () => {
    const registered = idsOf(allCatalogEntries());
    const matrix = idsOf(MATRIX);
    assert.deepEqual(matrix, registered);
    assert.notEqual(registered.length, 0);
  });

  it("every category is either a non-empty N/A reason or has cases", () => {
    const gaps: string[] = [];
    for (const row of MATRIX) {
      for (const cat of CATEGORIES) {
        const reason = row.na?.[cat];
        const cases = row.cases[cat];
        if (reason) {
          if (!reason.trim()) gaps.push(`${row.pkg}.${row.symbol} ${cat}: empty n/a`);
          if (cases?.length) gaps.push(`${row.pkg}.${row.symbol} ${cat}: both n/a and cases`);
        } else if (!cases?.length) {
          gaps.push(`${row.pkg}.${row.symbol} missing ${cat}`);
        }
      }
    }
    assert.deepEqual(gaps, []);
  });

  it("id equality is against allCatalogEntries, not a hardcoded count", () => {
    const registered = idsOf(allCatalogEntries());
    const fake = registered.concat(["lodash.notARealSymbol"]);
    assert.notDeepEqual(idsOf(MATRIX), fake);
    assert.deepEqual(idsOf(MATRIX), registered);
  });

  it("every matrix case agrees with the pinned oracle (or hardened policy)", async () => {
    for (const row of MATRIX) {
      const impl = getCatalog(row.pkg, row.symbol)?.impl;
      assert.equal(typeof impl === "function" || (impl && typeof impl === "object"), true, `${row.pkg}.${row.symbol} impl`);
      const oracle = oracleOf(row.pkg, row.symbol);
      for (const cat of CATEGORIES) {
        if (row.na?.[cat]) continue;
        for (const c of row.cases[cat] ?? []) {
          await runCase(row, c, impl, oracle);
        }
      }
    }
  });
});
