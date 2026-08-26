import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { MAX_HITS, NGRAM_N, runSimilarityGate } from "../scripts/similarity.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = tmpdir();

test("similarity gate passes against all pinned catalog oracles", () => {
  const r = runSimilarityGate();
  assert.equal(r.ok, true, r.failed);
  assert.deepEqual(r.missing, []);
  assert.ok(r.skipped.includes("locale"));
  assert.ok(!r.skipped.includes("fp"));
});

test("similarity gate fails closed when an oracle tree is missing", () => {
  mkdirSync(TMP, { recursive: true });
  const tmp = mkdtempSync(join(TMP, "slim-sim-"));
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

test("similarity gate fails on a copied-fragment fixture slice", () => {
  mkdirSync(TMP, { recursive: true });
  const tmp = mkdtempSync(join(TMP, "slim-sim-copy-"));
  try {
    const words = Array.from({ length: 20 }, (_, i) => `fragToken${i}xyz`);
    const oracleBody = words.join(" ") + ";\n";
    mkdirSync(join(tmp, "src/generate/catalog"), { recursive: true });
    writeFileSync(join(tmp, "src/generate/catalog/ok.ts"), "export const ok = 1;\n");
    mkdirSync(join(tmp, "node_modules/ms"), { recursive: true });
    writeFileSync(join(tmp, "node_modules/ms/index.js"), oracleBody);
    mkdirSync(join(tmp, "fixtures/copied/src/slim"), { recursive: true });
    writeFileSync(join(tmp, "fixtures/copied/src/slim/slice.ts"), oracleBody);
    const r = runSimilarityGate({ root: tmp, oraclePkgs: ["ms"] });
    assert.equal(r.ok, false, "copied fixture slice must fail the gate");
    assert.ok((r.worst ?? 0) > MAX_HITS);
    assert.match(r.worstFile.replace(/\\/g, "/"), /fixtures\/copied\/src\/slim\/slice\.ts/);
    assert.match(r.failed ?? "", new RegExp(String(NGRAM_N)));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("similarity gate worstFile is stable across two runs", () => {
  const a = runSimilarityGate();
  const b = runSimilarityGate();
  assert.equal(a.ok, b.ok);
  assert.equal(a.worst, b.worst);
  assert.equal(a.worstFile, b.worstFile);
});
