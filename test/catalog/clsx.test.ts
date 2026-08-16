import assert from "node:assert/strict";
import { describe, it } from "node:test";
import clsx, { clsx as namedClsx } from "../../src/generate/catalog/clsx.ts";

describe("clsx", () => {
  it("exports the same function as default and named", () => {
    assert.equal(clsx, namedClsx);
  });

  it("joins truthy strings", () => {
    assert.equal(clsx("foo", true && "bar", "baz"), "foo bar baz");
  });

  it("includes object keys whose values are truthy", () => {
    assert.equal(clsx({ foo: true, bar: false, baz: 1 }), "foo baz");
    assert.equal(
      clsx({ foo: true }, { bar: false }, null, { "--foobar": "hello" }),
      "foo --foobar",
    );
  });

  it("flattens arrays and nested arrays", () => {
    assert.equal(clsx(["foo", 0, false, "bar"]), "foo bar");
    assert.equal(
      clsx(["foo"], ["", 0, false, "bar"], [["baz", [["hello"], "there"]]]),
      "foo bar baz hello there",
    );
  });

  it("discards falsey and standalone booleans", () => {
    assert.equal(clsx(true, false, "", null, undefined, 0, NaN), "");
  });

  it("stringifies truthy numbers and skips 0", () => {
    assert.equal(clsx(1, 2, 0, "x"), "1 2 x");
  });

  it("handles the kitchen-sink mix from the public docs", () => {
    assert.equal(
      clsx("foo", [1 && "bar", { baz: false, bat: null }, ["hello", ["world"]]], "cya"),
      "foo bar hello world cya",
    );
  });

  it("returns an empty string with no arguments", () => {
    assert.equal(clsx(), "");
  });
});
