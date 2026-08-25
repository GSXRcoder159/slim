import assert from "node:assert/strict";
import { describe, it } from "node:test";
import msOracle from "ms";
import ms from "../../src/generate/catalog/ms.ts";

function same(input: string | number, opts?: { long?: boolean }): void {
  const label = typeof input === "string" ? JSON.stringify(input) : `${input} ${JSON.stringify(opts)}`;
  try {
    const got = opts ? ms(input as number, opts) : ms(input as never);
    const exp = opts ? msOracle(input, opts) : msOracle(input);
    assert.equal(got, exp, label);
  } catch (err) {
    assert.throws(
      () => (opts ? msOracle(input, opts) : msOracle(input)),
      err as Error,
      label,
    );
  }
}

describe("ms", () => {
  it("matches the pinned oracle for numeric and simple duration strings", () => {
    const parseCases = [
      "2 days",
      "1d",
      "10h",
      "2.5 hrs",
      "2h",
      "1m",
      "5s",
      "1y",
      "100",
      "-3 days",
      "-1h",
      "-200",
      "1.5h",
      "1 week",
      "1w",
      "1 millisecond",
      "1ms",
    ];
    for (const input of parseCases) same(input);
    for (const n of [60000, 2 * 60000, -3 * 60000, 1, 86400000, 0]) {
      same(n);
      same(n, { long: true });
    }
  });

  it("matches the pinned oracle for compound, invalid, empty, and oversized inputs", () => {
    const cases = [
      "1h 30m",
      "1h30m",
      "1 hour 30 minutes",
      "nope",
      "1 lightyear",
      "",
      `${"1".repeat(101)}d`,
      `${"1".repeat(100)}`,
      "   ",
    ];
    for (const input of cases) {
      let catalogErr: unknown;
      let oracleErr: unknown;
      let catalogVal: unknown;
      let oracleVal: unknown;
      try {
        catalogVal = ms(input);
      } catch (e) {
        catalogErr = e;
      }
      try {
        oracleVal = msOracle(input);
      } catch (e) {
        oracleErr = e;
      }
      if (catalogErr || oracleErr) {
        assert.ok(catalogErr instanceof Error, `catalog throw for ${JSON.stringify(input)}`);
        assert.ok(oracleErr instanceof Error, `oracle throw for ${JSON.stringify(input)}`);
        assert.equal((catalogErr as Error).name, (oracleErr as Error).name, input);
        assert.equal((catalogErr as Error).message, (oracleErr as Error).message, input);
      } else {
        assert.equal(catalogVal, oracleVal, input);
      }
    }
  });

  it("throws like the oracle on non-string non-finite values", () => {
    for (const input of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, true, null, undefined]) {
      let catalogErr: unknown;
      let oracleErr: unknown;
      try {
        ms(input as never);
      } catch (e) {
        catalogErr = e;
      }
      try {
        msOracle(input as never);
      } catch (e) {
        oracleErr = e;
      }
      assert.ok(catalogErr instanceof Error);
      assert.ok(oracleErr instanceof Error);
      assert.equal((catalogErr as Error).name, (oracleErr as Error).name);
      assert.equal((catalogErr as Error).message, (oracleErr as Error).message);
    }
  });
});
