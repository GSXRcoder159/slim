import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import { gzipGuess, KNOWN_MIN_BYTES } from "../src/size/estimate.ts";
import { validateNamed } from "../src/schema/documents.ts";
import {
  MEASUREMENT_COMMAND,
  MEASUREMENT_MAX_AGE_DAYS,
  MEASUREMENT_MAX_AGE_MS,
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
  assert.ok(slice.parseNs.value != null && slice.parseNs.value > 0);
  assert.match(slice.sha256 ?? "", /^[0-9a-f]{64}$/);
  assert.equal(doc.schemaVersion, 1);
  assert.equal(doc.command, MEASUREMENT_COMMAND);
  assert.equal(doc.maxAgeDays, MEASUREMENT_MAX_AGE_DAYS);
  assert.equal(doc.estimatedOriginalMin.lodash.provenance, "estimated");
  assert.equal(doc.estimatedOriginalMin.lodash.value, KNOWN_MIN_BYTES.lodash);
  assert.equal(doc.estimatedOriginalMin.lodash.gzipBytes, gzipGuess(KNOWN_MIN_BYTES.lodash ?? 0));
  assert.ok((doc.estimatedOriginalMin.lodash.value ?? 0) > (slice.bytes.value ?? 0));
  assert.equal(doc.files.workerColdStart.bytes.provenance, "unavailable");
  assert.ok(doc.files.workerColdStart.bytes.reason);
  for (const name of Object.keys(KNOWN_MIN_BYTES)) {
    assert.equal(doc.estimatedOriginalMin[name]?.provenance, "estimated");
    assert.equal(doc.estimatedOriginalMin[name]?.value, KNOWN_MIN_BYTES[name]);
  }
});

test("committed measurements.json is current against live measureClaims", async () => {
  const path = join(ROOT, "docs/measurements.json");
  assert.ok(existsSync(path), "docs/measurements.json must exist");
  const committed = JSON.parse(readFileSync(path, "utf8")) as ClaimsDoc;
  const live = await measureClaims(ROOT);
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string };
  assert.equal(committed.slimVersion, pkg.version);
  assert.equal(validateNamed("measurements", committed), null);
  assertClaimsCurrent(committed, live);
  assert.equal(committed.files.goldenLodashSlice.parseNs.provenance, "measured");
  assert.ok(
    committed.files.goldenLodashSlice.parseNs.value != null &&
      committed.files.goldenLodashSlice.parseNs.value > 0,
  );
  const packages = readFileSync(join(ROOT, "docs/packages.md"), "utf8");
  const dx = readFileSync(join(ROOT, "docs/dx.md"), "utf8");
  const bytes = String(committed.files.goldenLodashSlice.bytes.value);
  const gzip = String(committed.files.goldenLodashSlice.gzipBytes.value);
  assert.match(packages, new RegExp(`${bytes} B / ${gzip} B gzip`));
  assert.match(dx, new RegExp(`${bytes} B / ${gzip} B gzip`));
  assert.match(packages, /unavailable \(not golden-measured\)/);
  const catalog = ["lodash", "whatwg-url", "mime-types", "bluebird", "moment", "uuid", "ms", "nanoid", "clsx"];
  for (const name of catalog) {
    const row = committed.estimatedOriginalMin[name];
    assert.ok(row, name);
    const minKb = `${(row.value / 1000).toFixed(1)} kB`;
    const gzKb = `${(row.gzipBytes / 1000).toFixed(1)} kB`;
    assert.match(packages, new RegExp(minKb.replace(".", "\\.")));
    assert.match(packages, new RegExp(gzKb.replace(".", "\\.")));
  }
});

test("assertClaimsCurrent fails on stale bytes gzip version sha256 freshness or estimated provenance", async () => {
  const live = await measureClaims(ROOT);
  const staleBytes = structuredClone(live);
  staleBytes.files.goldenLodashSlice.bytes.value =
    (staleBytes.files.goldenLodashSlice.bytes.value ?? 0) + 1;
  assert.throws(() => assertClaimsCurrent(staleBytes, live), /stale|bytes/i);

  const staleGzip = structuredClone(live);
  staleGzip.files.goldenLodashSlice.gzipBytes.value =
    (staleGzip.files.goldenLodashSlice.gzipBytes.value ?? 0) + 1;
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

  const missingSha = structuredClone(live);
  missingSha.files.goldenLodashSlice.sha256 = null;
  assert.throws(() => assertClaimsCurrent(missingSha, live), /sha256/i);

  const staleSha = structuredClone(live);
  staleSha.files.goldenLodashSlice.sha256 = "0".repeat(64);
  assert.throws(() => assertClaimsCurrent(staleSha, live), /sha256/i);

  const expired = structuredClone(live);
  expired.date = "2020-01-01";
  assert.throws(
    () => assertClaimsCurrent(expired, live, new Date("2026-08-29T00:00:00.000Z")),
    /freshness|older than/i,
  );
  assert.ok(MEASUREMENT_MAX_AGE_MS > 0);

  const workerMeasured = structuredClone(live);
  workerMeasured.files.workerColdStart.bytes.provenance = "measured";
  workerMeasured.files.workerColdStart.bytes.value = 1;
  assert.throws(() => assertClaimsCurrent(workerMeasured, live), /workerColdStart|unavailable/i);

  const parseNsDrift = structuredClone(live);
  parseNsDrift.files.goldenLodashSlice.parseNs.value =
    (parseNsDrift.files.goldenLodashSlice.parseNs.value ?? 0) + 999999;
  assert.doesNotThrow(() => assertClaimsCurrent(parseNsDrift, live));
  parseNsDrift.date = "2020-01-01";
  assert.throws(
    () => assertClaimsCurrent(parseNsDrift, live, new Date("2026-08-29T00:00:00.000Z")),
    /freshness|older than/i,
  );
  const withTolerance = structuredClone(live) as ClaimsDoc & {
    files: { goldenLodashSlice: { parseNs: { tolerance?: number } } };
  };
  withTolerance.files.goldenLodashSlice.parseNs.tolerance = 10;
  assert.throws(() => assertClaimsCurrent(withTolerance, live), /tolerance/i);
});

test("measure:claims source supports --check and has no parseNs tolerance", () => {
  const src = readFileSync(join(ROOT, "scripts", "measure-claims.ts"), "utf8");
  assert.match(src, /--check/);
  assert.match(src, /older than freshness window/);
  assert.doesNotMatch(src, /parseNsDrift/);
  assert.doesNotMatch(src, /Math\.abs\(.*parseNs/);
});
