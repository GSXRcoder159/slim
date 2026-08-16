import { test } from "node:test";
import assert from "node:assert/strict";
import { sliceExposure } from "../src/upstream/slice.ts";

test("CWE-1321 with get in envelope is exposed", () => {
  const exp = sliceExposure(
    {
      id: "GHSA-x",
      summary: "Prototype pollution",
      details: "via _.set",
      database_specific: { cwe_ids: ["CWE-1321"] },
    },
    ["get", "debounce"],
  );
  assert.equal(exp, "exposed");
});

test("unmapped advisory fail-closed", () => {
  const exp = sliceExposure(
    {
      id: "GHSA-y",
      summary: "Something vague in lodash",
      details: "See advisory.",
    },
    ["get"],
  );
  assert.equal(exp, "unmapped");
});
