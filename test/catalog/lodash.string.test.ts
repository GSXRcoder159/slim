import assert from "node:assert/strict";
import { describe, it } from "node:test";
import lodash from "lodash";
import { camelCase } from "../../src/generate/catalog/lodash.camelCase.ts";
import { kebabCase } from "../../src/generate/catalog/lodash.kebabCase.ts";
import { snakeCase } from "../../src/generate/catalog/lodash.snakeCase.ts";

const samples = [
  "Foo Bar",
  "--foo-bar--",
  "__FOO_BAR__",
  "fooBar",
  "XMLHttpRequest",
  "foo2bar",
  "12ft",
  "foo2Bar",
  null,
  undefined,
  "",
  ["Foo", "Bar"],
  "don't walk",
];

describe("lodash string case", () => {
  it("camelCase / kebabCase / snakeCase match lodash on the public examples plus extras", () => {
    assert.equal(camelCase("Foo Bar"), "fooBar");
    assert.equal(camelCase("--foo-bar--"), "fooBar");
    assert.equal(camelCase("__FOO_BAR__"), "fooBar");
    assert.equal(kebabCase("Foo Bar"), "foo-bar");
    assert.equal(kebabCase("fooBar"), "foo-bar");
    assert.equal(snakeCase("Foo Bar"), "foo_bar");
    for (const s of samples) {
      assert.equal(camelCase(s), lodash.camelCase(s as never), `camel ${String(s)}`);
      assert.equal(kebabCase(s), lodash.kebabCase(s as never), `kebab ${String(s)}`);
      assert.equal(snakeCase(s), lodash.snakeCase(s as never), `snake ${String(s)}`);
    }
  });
});
