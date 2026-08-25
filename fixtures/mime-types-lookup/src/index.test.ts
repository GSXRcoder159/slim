import { test } from "node:test";
import assert from "node:assert/strict";
import { typeOf } from "./index.ts";

test("looks up common web types", () => {
  assert.equal(typeOf("index.html"), "text/html");
  assert.equal(typeOf("data.json"), "application/json");
});
