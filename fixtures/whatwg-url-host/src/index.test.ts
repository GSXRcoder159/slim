import { test } from "node:test";
import assert from "node:assert/strict";
import { host, query, viaDefault } from "./index.ts";

test("parses a hostname from an absolute URL", () => {
  assert.equal(host("https://example.com/path?q=1"), "example.com");
});

test("URLSearchParams and default namespace", () => {
  assert.equal(query("https://example.com/path?q=hi"), "hi");
  assert.equal(viaDefault("https://example.com/x"), "example.com");
});
