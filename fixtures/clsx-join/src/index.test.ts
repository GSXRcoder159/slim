import { test } from "node:test";
import assert from "node:assert/strict";
import { classes } from "./index.ts";

test("joins truthy class names", () => {
  assert.equal(classes(true), "btn btn-active px-2");
  assert.equal(classes(false), "btn px-2");
});
