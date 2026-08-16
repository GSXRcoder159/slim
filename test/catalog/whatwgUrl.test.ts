import assert from "node:assert/strict";
import { describe, it } from "node:test";
import whatwgUrl, {
  URL,
  URLSearchParams,
} from "../../src/generate/catalog/whatwgUrl.ts";

describe("whatwg-url catalog", () => {
  it("re-exports the platform URL constructor", () => {
    assert.equal(URL, globalThis.URL);
    const u = new URL("https://example.com/path?q=1#hash");
    assert.equal(u.hostname, "example.com");
    assert.equal(u.pathname, "/path");
    assert.equal(u.searchParams.get("q"), "1");
    assert.equal(u.hash, "#hash");
  });

  it("resolves relative URLs against a base", () => {
    assert.equal(new URL("/x", "https://example.com/a/b").href, "https://example.com/x");
  });

  it("re-exports URLSearchParams", () => {
    assert.equal(URLSearchParams, globalThis.URLSearchParams);
    const q = new URLSearchParams("a=1&b=2");
    q.set("c", "3");
    assert.equal(q.get("a"), "1");
    assert.equal(q.toString(), "a=1&b=2&c=3");
  });

  it("exposes URL and URLSearchParams on the default export", () => {
    assert.equal(whatwgUrl.URL, globalThis.URL);
    assert.equal(whatwgUrl.URLSearchParams, globalThis.URLSearchParams);
  });
});
