import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runSimilarityGate } from "../scripts/similarity.ts";

test("similarity gate passes against all pinned catalog oracles", () => {
  const r = runSimilarityGate();
  assert.equal(r.ok, true, r.failed);
  assert.deepEqual(r.missing, []);
});

test("similarity gate fails closed when an oracle tree is missing", () => {
  const tmp = mkdtempSync(join(tmpdir(), "slim-sim-"));
  try {
    mkdirSync(join(tmp, "src/generate/catalog"), { recursive: true });
    writeFileSync(join(tmp, "src/generate/catalog/ms.ts"), "export function ms() { return 1; }\n");
    const r = runSimilarityGate({ root: tmp, oraclePkgs: ["ms"] });
    assert.equal(r.ok, false);
    assert.ok(r.missing.includes("ms"));
    assert.match(r.failed ?? "", /missing oracle/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
