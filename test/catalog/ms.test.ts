import assert from "node:assert/strict";
import { describe, it } from "node:test";
import ms from "../../src/generate/catalog/ms.ts";

describe("ms", () => {
  it("parses common duration strings from the public docs", () => {
    assert.equal(ms("2 days"), 172800000);
    assert.equal(ms("1d"), 86400000);
    assert.equal(ms("10h"), 36000000);
    assert.equal(ms("2.5 hrs"), 9000000);
    assert.equal(ms("2h"), 7200000);
    assert.equal(ms("1m"), 60000);
    assert.equal(ms("5s"), 5000);
    assert.equal(ms("1y"), 31557600000);
    assert.equal(ms("100"), 100);
    assert.equal(ms("-3 days"), -259200000);
    assert.equal(ms("-1h"), -3600000);
    assert.equal(ms("-200"), -200);
  });

  it("parses compound durations", () => {
    assert.equal(ms("1h 30m"), 5400000);
    assert.equal(ms("1h30m"), 5400000);
    assert.equal(ms("1 hour 30 minutes"), 5400000);
  });

  it("stringifies milliseconds with short units", () => {
    assert.equal(ms(60000), "1m");
    assert.equal(ms(2 * 60000), "2m");
    assert.equal(ms(-3 * 60000), "-3m");
    assert.equal(ms(ms("10 hours") as number), "10h");
  });

  it("stringifies with { long: true }", () => {
    assert.equal(ms(60000, { long: true }), "1 minute");
    assert.equal(ms(2 * 60000, { long: true }), "2 minutes");
    assert.equal(ms(-3 * 60000, { long: true }), "-3 minutes");
    assert.equal(ms(ms("10 hours") as number, { long: true }), "10 hours");
  });

  it("returns undefined for unparseable strings", () => {
    assert.equal(ms("nope"), undefined);
    assert.equal(ms("1 lightyear"), undefined);
  });

  it("throws on empty string or non-finite numbers", () => {
    assert.throws(() => ms(""), { name: "Error" });
    assert.throws(() => ms(Number.POSITIVE_INFINITY), { name: "Error" });
    assert.throws(() => ms(true as unknown as string), { name: "Error" });
  });

  it("rejects strings longer than 100 characters", () => {
    assert.throws(() => ms(`${"1".repeat(101)}d`), { name: "Error" });
  });
});
