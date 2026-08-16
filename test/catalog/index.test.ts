import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  catalogSymbols,
  getCatalog,
  matchCatalog,
} from "../../src/generate/catalog/index.ts";
import { v4 } from "../../src/generate/catalog/uuid.ts";
import { nanoid } from "../../src/generate/catalog/nanoid.ts";
import { clsx } from "../../src/generate/catalog/clsx.ts";

describe("catalog matcher", () => {
  it("lists symbols for a known package", () => {
    assert.ok(catalogSymbols("uuid").includes("v4"));
    assert.ok(catalogSymbols("nanoid").includes("nanoid"));
    assert.ok(catalogSymbols("clsx").includes("clsx"));
    assert.ok(catalogSymbols("ms").includes("default"));
    assert.ok(catalogSymbols("mime-types").includes("lookup"));
    assert.ok(catalogSymbols("whatwg-url").includes("URL"));
    assert.ok(catalogSymbols("bluebird").includes("delay"));
    assert.ok(catalogSymbols("moment").includes("default"));
  });

  it("aliases lodash-es / underscore to the lodash symbol list", () => {
    const lodash = catalogSymbols("lodash");
    assert.ok(lodash.includes("get"));
    assert.ok(lodash.includes("debounce"));
    assert.deepEqual(catalogSymbols("lodash-es"), lodash);
    assert.deepEqual(catalogSymbols("underscore"), lodash);
  });

  it("getCatalog returns the live implementation", () => {
    assert.equal(getCatalog("uuid", "v4")?.impl, v4);
    assert.equal(getCatalog("nanoid", "nanoid")?.impl, nanoid);
    assert.equal(getCatalog("clsx", "clsx")?.impl, clsx);
    assert.equal(getCatalog("nope", "x"), undefined);
  });

  it("matchCatalog splits matched entries from missing symbols", () => {
    const { matched, missing } = matchCatalog("uuid", ["v4", "v7"]);
    assert.deepEqual(missing, ["v7"]);
    assert.equal(matched.length, 1);
    assert.equal(matched[0].pkg, "uuid");
    assert.equal(matched[0].symbol, "v4");
    assert.equal(matched[0].impl, v4);
  });

  it("matchCatalog lists lodash coverage even when lodash.ts is a sibling module", () => {
    const { matched, missing } = matchCatalog("lodash", ["get", "debounce", "template"]);
    assert.deepEqual(missing, ["template"]);
    const ids = matched.map((e) => e.symbol).sort();
    assert.deepEqual(ids, ["debounce", "get"]);
    for (const entry of matched) {
      assert.equal(typeof entry.impl, "function");
      assert.equal(entry.pkg, "lodash");
    }
  });

  it("aliases mime-db and url-parse", () => {
    assert.ok(catalogSymbols("mime-db").includes("lookup"));
    assert.ok(catalogSymbols("url-parse").includes("URL"));
  });
});
