import assert from "node:assert/strict";
import { describe, it } from "node:test";
import lodash from "lodash";
import { identity } from "../../src/generate/catalog/lodash.identity.ts";
import { noop } from "../../src/generate/catalog/lodash.noop.ts";
import { defaultTo } from "../../src/generate/catalog/lodash.defaultTo.ts";
import { get, debounce, isEmpty } from "../../src/generate/catalog/lodash.ts";
import { getCatalog } from "../../src/generate/catalog/index.ts";

describe("lodash.identity / noop / defaultTo", () => {
  it("identity returns its argument", () => {
    const o = { a: 1 };
    assert.equal(identity(o), o);
    assert.equal(identity(o), lodash.identity(o));
  });

  it("noop returns undefined", () => {
    assert.equal(noop(), undefined);
    assert.equal(noop(1, 2, 3), lodash.noop(1, 2, 3));
  });

  it("defaultTo replaces only null, undefined, and NaN", () => {
    assert.equal(defaultTo(1, 10), lodash.defaultTo(1, 10));
    assert.equal(defaultTo(undefined, 10), lodash.defaultTo(undefined, 10));
    assert.equal(defaultTo(null, 10), lodash.defaultTo(null, 10));
    assert.equal(defaultTo(NaN, 10), lodash.defaultTo(NaN, 10));
    assert.equal(defaultTo(0, 10), lodash.defaultTo(0, 10));
    assert.equal(defaultTo("", 10), lodash.defaultTo("", 10));
    assert.equal(defaultTo(false, 10), lodash.defaultTo(false, 10));
  });
});

describe("lodash.ts barrel", () => {
  it("re-exports catalog functions used by getCatalog", () => {
    assert.equal(getCatalog("lodash", "get")?.impl, get);
    assert.equal(getCatalog("lodash", "debounce")?.impl, debounce);
    assert.equal(getCatalog("lodash", "isEmpty")?.impl, isEmpty);
    assert.equal(typeof getCatalog("lodash", "first")?.impl, "function");
  });
});
