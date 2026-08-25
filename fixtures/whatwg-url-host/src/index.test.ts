import { test } from "node:test";
import assert from "node:assert/strict";
import { host } from "./index.ts";

test("parses a hostname from an absolute URL", () => {
  assert.equal(host("https://example.com/path?q=1"), "example.com");
});
