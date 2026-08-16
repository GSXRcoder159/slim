import { test } from "node:test";
import assert from "node:assert/strict";
import { collectDoctor } from "../src/doctor.ts";

test("doctor sees this Node as ok", () => {
  const r = collectDoctor();
  assert.equal(r.nodeOk, true);
  assert.equal(r.registerHooks, true);
  assert.equal(r.node, process.versions.node);
});
