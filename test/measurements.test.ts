import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import { KNOWN_MIN_BYTES } from "../src/size/estimate.ts";
import {
  assertClaimsCurrent,
  measureClaims,
  type ClaimsDoc,
} from "../scripts/measure-claims.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

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
  assert.equal(doc.estimatedOriginalMin.lodash.value, KNOWN_MIN_BYTES.lodash);
  assert.ok(doc.estimatedOriginalMin.lodash.value > slice.bytes.value);
});

test("committed measurements.json is current against live measureClaims", async () => {
  const path = join(ROOT, "docs/measurements.json");
  assert.ok(existsSync(path), "docs/measurements.json must exist");
  const committed = JSON.parse(readFileSync(path, "utf8")) as ClaimsDoc;
  const live = await measureClaims(ROOT);
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string };
  assert.equal(committed.slimVersion, pkg.version);
  assertClaimsCurrent(committed, live);
  assert.equal(committed.files.goldenLodashSlice.parseNs.provenance, "measured");
  assert.ok(committed.files.goldenLodashSlice.parseNs.value > 0);
  const packages = readFileSync(join(ROOT, "docs/packages.md"), "utf8");
  const dx = readFileSync(join(ROOT, "docs/dx.md"), "utf8");
  const bytes = String(committed.files.goldenLodashSlice.bytes.value);
  const gzip = String(committed.files.goldenLodashSlice.gzipBytes.value);
  assert.match(packages, new RegExp(`${bytes} B / ${gzip} B gzip`));
  assert.match(dx, new RegExp(`${bytes} B / ${gzip} B gzip`));
});

test("assertClaimsCurrent fails on stale bytes gzip version or estimated provenance", async () => {
  const live = await measureClaims(ROOT);
  const staleBytes = structuredClone(live);
  staleBytes.files.goldenLodashSlice.bytes.value += 1;
  assert.throws(() => assertClaimsCurrent(staleBytes, live), /stale|bytes/i);

  const staleGzip = structuredClone(live);
  staleGzip.files.goldenLodashSlice.gzipBytes.value += 1;
  assert.throws(() => assertClaimsCurrent(staleGzip, live), /stale|gzip/i);

  const staleVer = structuredClone(live);
  staleVer.slimVersion = "0.0.0-stale";
  assert.throws(() => assertClaimsCurrent(staleVer, live), /slimVersion/i);

  const estimated = structuredClone(live);
  estimated.files.goldenLodashSlice.bytes.provenance = "estimated";
  assert.throws(() => assertClaimsCurrent(estimated, live), /provenance|measured/i);

  const parseUnmeasured = structuredClone(live);
  parseUnmeasured.files.goldenLodashSlice.parseNs.provenance = "estimated";
  assert.throws(() => assertClaimsCurrent(parseUnmeasured, live), /parseNs|provenance/i);

  const parseNsDrift = structuredClone(live);
  parseNsDrift.files.goldenLodashSlice.parseNs.value += 999999;
  assert.doesNotThrow(() => assertClaimsCurrent(parseNsDrift, live));
});
