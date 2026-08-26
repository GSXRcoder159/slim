import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import { measureClaims } from "../scripts/measure-claims.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("refresh:golden pins --seed 1 and excludes traces.jsonl", () => {
  const src = readFileSync(join(ROOT, "scripts/refresh-golden-fixture.ts"), "utf8");
  assert.match(src, /"--seed"/);
  assert.match(src, /"1"/);
  assert.match(src, /traces\.jsonl/);
  assert.doesNotMatch(src, /copyIfExists\([^)]*traces\.jsonl/);
});

test("measureClaims labels bytes gzip parse as measured and original min as estimated", async () => {
  const doc = await measureClaims(ROOT);
  const slice = doc.files.goldenLodashSlice;
  assert.ok(slice);
  const raw = readFileSync(join(ROOT, slice.path));
  assert.equal(slice.bytes.value, raw.length);
  assert.equal(slice.bytes.provenance, "measured");
  assert.equal(slice.gzipBytes.value, gzipSync(raw).length);
  assert.equal(slice.gzipBytes.provenance, "measured");
  assert.equal(slice.parseNs.provenance, "measured");
  assert.ok(slice.parseNs.value > 0);
  assert.equal(doc.estimatedOriginalMin.lodash.provenance, "estimated");
  assert.ok(doc.estimatedOriginalMin.lodash.value > slice.bytes.value);
});

test("committed measurements.json matches measured slice bytes", async () => {
  const path = join(ROOT, "docs/measurements.json");
  assert.ok(existsSync(path), "docs/measurements.json must exist");
  const committed = JSON.parse(readFileSync(path, "utf8")) as {
    files: { goldenLodashSlice: { bytes: { value: number; provenance: string } } };
    estimatedOriginalMin: { lodash: { provenance: string } };
  };
  const live = await measureClaims(ROOT);
  assert.equal(committed.files.goldenLodashSlice.bytes.value, live.files.goldenLodashSlice.bytes.value);
  assert.equal(committed.estimatedOriginalMin.lodash.provenance, "estimated");
});
