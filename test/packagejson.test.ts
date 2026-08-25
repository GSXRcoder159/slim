import { test } from "node:test";
import assert from "node:assert/strict";
import { removeDependencyKey, restoreDependencyKey } from "../src/rewrite/packagejson.ts";

test("removes a dep key and the previous comma", () => {
  const src = `{
  "dependencies": {
    "left-pad": "1.0.0",
    "lodash": "4.17.21"
  }
}
`;
  const next = removeDependencyKey(src, "lodash");
  assert.equal(next.removed, true);
  assert.equal(next.text.includes("lodash"), false);
  assert.equal(next.text.includes("left-pad"), true);
  JSON.parse(next.text);
});

test("restoreDependencyKey puts the dep back", () => {
  const src = `{
  "dependencies": {
    "left-pad": "1.0.0"
  }
}
`;
  const next = restoreDependencyKey(src, "lodash", "4.17.21");
  const json = JSON.parse(next) as { dependencies: Record<string, string> };
  assert.equal(json.dependencies.lodash, "4.17.21");
  assert.equal(json.dependencies["left-pad"], "1.0.0");
});
