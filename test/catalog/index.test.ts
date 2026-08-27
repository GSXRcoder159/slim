import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CATALOG_ORACLES,
  CATALOG_PKG_ALIAS,
  allCatalogEntries,
  catalogSymbols,
  getCatalog,
  matchCatalog,
} from "../../src/generate/catalog/index.ts";
import { resolvePackageFamily } from "../../src/analyze/family.ts";
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

  it("aliases classnames to the clsx catalog", () => {
    assert.deepEqual(catalogSymbols("classnames"), catalogSymbols("clsx"));
    assert.equal(getCatalog("classnames", "clsx")?.impl, clsx);
    const { matched, missing } = matchCatalog("classnames", ["clsx", "default"]);
    assert.deepEqual(missing, []);
    assert.equal(matched.length, 2);
  });

  it("lists groupBy on the lodash catalog", () => {
    assert.ok(catalogSymbols("lodash").includes("groupBy"));
    assert.equal(typeof getCatalog("lodash", "groupBy")?.impl, "function");
    const { missing } = matchCatalog("lodash", ["groupBy"]);
    assert.deepEqual(missing, []);
  });

  it("pins installed catalog oracles to CATALOG_ORACLES", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    for (const [pkg, pin] of Object.entries(CATALOG_ORACLES)) {
      const pkgJson = join(root, "node_modules", pkg, "package.json");
      const installed = JSON.parse(readFileSync(pkgJson, "utf8")) as { version: string };
      assert.equal(installed.version, pin, `${pkg} must be pinned at ${pin}`);
    }
  });

  it("allCatalogEntries is the unique registered (pkg, symbol) set", () => {
    const entries = allCatalogEntries();
    const ids = entries.map((e) => `${e.pkg}.${e.symbol}`).sort();
    assert.equal(ids.length, new Set(ids).size, "duplicate catalog ids");
    const families = [...new Set(entries.map((e) => e.pkg))];
    const fromMatch = families.flatMap((pkg) =>
      catalogSymbols(pkg).map((symbol) => `${pkg}.${symbol}`),
    ).sort();
    assert.deepEqual(ids, fromMatch);
    assert.ok(ids.length > 0);
    assert.equal(
      ids.length,
      fromMatch.length,
      "allCatalogEntries must match matchCatalog's canonical symbol set",
    );
  });

  it("every catalog package alias resolves to that family in analyze", () => {
    for (const [alias, canonical] of Object.entries(CATALOG_PKG_ALIAS)) {
      const fam = resolvePackageFamily(alias);
      assert.equal(fam?.family, canonical, `${alias} family`);
    }
    const perMethod = resolvePackageFamily("lodash.get");
    assert.equal(perMethod?.family, "lodash");
    assert.equal(perMethod?.subpath, "get");
    assert.ok(catalogSymbols("mime").includes("lookup"));
  });
});
