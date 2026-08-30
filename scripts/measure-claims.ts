#!/usr/bin/env node
/**
 * Versioned size/parse receipts for public claims.
 * Bytes and gzip are artifact-bound. parseNs is measured on this machine,
 * labeled, and freshness-gated — never accepted by a numeric tolerance.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { platform } from "node:os";
import { gzipGuess, KNOWN_MIN_BYTES } from "../src/size/estimate.ts";
import { sha256File } from "../src/evidence/digests.ts";
import { assertDocument } from "../src/schema/documents.ts";
import {
  MEASUREMENT_COMMAND,
  MEASUREMENT_MAX_AGE_DAYS,
  MEASUREMENT_MAX_AGE_MS,
  assertClaimsFresh,
  claimDateMs,
  qualifyMeasurementClaims,
  readCommittedClaims,
  type ClaimValue,
  type ClaimsDoc,
  type EstimatedMin,
  type MeasuredFile,
} from "../src/support/measurements.ts";

export {
  MEASUREMENT_COMMAND,
  MEASUREMENT_MAX_AGE_DAYS,
  MEASUREMENT_MAX_AGE_MS,
  assertClaimsFresh,
  qualifyMeasurementClaims,
  readCommittedClaims,
};
export type { ClaimValue, ClaimsDoc, EstimatedMin, MeasuredFile, Provenance } from "../src/support/measurements.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const WORKER_UNAVAILABLE =
  "Worker isolate CPU is a vendor budget, not measured here.";

async function parseNs(file: string): Promise<number> {
  const href = pathToFileURL(file).href;
  const t0 = process.hrtime.bigint();
  await import(href + `?t=${t0}`);
  return Number(process.hrtime.bigint() - t0);
}

function unavailableFile(path: string, reason: string): MeasuredFile {
  const claim: ClaimValue = { value: null, provenance: "unavailable", reason };
  return { path, sha256: null, bytes: claim, gzipBytes: { ...claim }, parseNs: { ...claim } };
}

async function measureFile(root: string, abs: string): Promise<MeasuredFile> {
  const buf = readFileSync(abs);
  const gz = gzipSync(buf);
  return {
    path: abs.slice(root.length + 1),
    sha256: sha256File(abs),
    bytes: { value: buf.length, provenance: "measured" },
    gzipBytes: { value: gz.length, provenance: "measured" },
    parseNs: { value: await parseNs(abs), provenance: "measured" },
  };
}

export async function measureClaims(root = ROOT): Promise<ClaimsDoc> {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
  const slice = join(root, "fixtures/lodash-get-debounce/src/slim/lodash.ts");
  const lodashEntry = join(root, "node_modules/lodash/lodash.js");

  const estimatedOriginalMin: Record<string, EstimatedMin> = {};
  for (const [name, value] of Object.entries(KNOWN_MIN_BYTES)) {
    estimatedOriginalMin[name] = {
      value,
      gzipBytes: gzipGuess(value),
      provenance: "estimated",
      source: "src/size/estimate.ts KNOWN_MIN_BYTES",
    };
  }

  return {
    schemaVersion: 1,
    command: MEASUREMENT_COMMAND,
    slimVersion: pkg.version,
    node: process.versions.node,
    os: platform(),
    date: new Date().toISOString().slice(0, 10),
    maxAgeDays: MEASUREMENT_MAX_AGE_DAYS,
    notes:
      "Node parse/size of the golden lodash slice vs installed lodash.js. Worker isolate CPU is unavailable. Catalog mins are estimated. parseNs is env-local and expires with the receipt.",
    files: {
      goldenLodashSlice: await measureFile(root, slice),
      lodashOracleEntry: existsSync(lodashEntry)
        ? await measureFile(root, lodashEntry)
        : unavailableFile("node_modules/lodash/lodash.js", "lodash oracle is not installed"),
      workerColdStart: unavailableFile("", WORKER_UNAVAILABLE),
    },
    estimatedOriginalMin,
  };
}

function requireMeasuredPositive(claim: ClaimValue, label: string): void {
  if (claim.provenance !== "measured") {
    throw new Error(`${label} provenance must be measured`);
  }
  if (claim.value == null || !(claim.value > 0)) {
    throw new Error(`${label} must be measured with value > 0`);
  }
}

function requireSha256(file: MeasuredFile, label: string): void {
  if (!file.sha256 || !/^[0-9a-f]{64}$/.test(file.sha256)) {
    throw new Error(`${label} sha256 is required`);
  }
}

export function assertClaimsCurrent(
  committed: ClaimsDoc,
  live: ClaimsDoc,
  now = new Date(),
): void {
  if (committed.schemaVersion !== 1 || live.schemaVersion !== 1) {
    throw new Error(`stale measurements schemaVersion`);
  }
  if (committed.command !== MEASUREMENT_COMMAND) {
    throw new Error(`measurements command must be ${MEASUREMENT_COMMAND}`);
  }
  if (committed.maxAgeDays !== MEASUREMENT_MAX_AGE_DAYS) {
    throw new Error(`measurements maxAgeDays must be ${MEASUREMENT_MAX_AGE_DAYS}`);
  }
  if (committed.slimVersion !== live.slimVersion) {
    throw new Error(`stale measurements slimVersion ${committed.slimVersion} !== ${live.slimVersion}`);
  }
  const age = now.getTime() - claimDateMs(committed.date);
  if (age > MEASUREMENT_MAX_AGE_MS) {
    throw new Error(`measurements date ${committed.date} is older than freshness window`);
  }

  const sliceC = committed.files.goldenLodashSlice;
  const sliceL = live.files.goldenLodashSlice;
  if (!sliceC || !sliceL) throw new Error("missing goldenLodashSlice");
  if (sliceC.bytes.provenance !== "measured" || sliceL.bytes.provenance !== "measured") {
    throw new Error("goldenLodashSlice.bytes provenance must be measured");
  }
  if (sliceC.bytes.value !== sliceL.bytes.value) {
    throw new Error(`stale goldenLodashSlice.bytes ${sliceC.bytes.value} !== ${sliceL.bytes.value}`);
  }
  if (sliceC.gzipBytes.provenance !== "measured" || sliceL.gzipBytes.provenance !== "measured") {
    throw new Error("goldenLodashSlice.gzipBytes provenance must be measured");
  }
  if (sliceC.gzipBytes.value !== sliceL.gzipBytes.value) {
    throw new Error(`stale goldenLodashSlice.gzip ${sliceC.gzipBytes.value} !== ${sliceL.gzipBytes.value}`);
  }
  requireSha256(sliceC, "goldenLodashSlice");
  requireSha256(sliceL, "live goldenLodashSlice");
  if (sliceC.sha256 !== sliceL.sha256) {
    throw new Error(`stale goldenLodashSlice.sha256`);
  }
  requireMeasuredPositive(sliceC.parseNs, "goldenLodashSlice.parseNs");
  requireMeasuredPositive(sliceL.parseNs, "live goldenLodashSlice.parseNs");
  if ("tolerance" in sliceC.parseNs || "tolerance" in sliceL.parseNs) {
    throw new Error("parseNs tolerance is not accepted");
  }

  if (committed.files.workerColdStart.bytes.provenance !== "unavailable") {
    throw new Error("workerColdStart must be unavailable");
  }
  if (live.files.workerColdStart.bytes.provenance !== "unavailable") {
    throw new Error("live workerColdStart must be unavailable");
  }

  const catalogKeys = Object.keys(KNOWN_MIN_BYTES).sort();
  const committedKeys = Object.keys(committed.estimatedOriginalMin).sort();
  const liveKeys = Object.keys(live.estimatedOriginalMin).sort();
  if (committedKeys.join(",") !== catalogKeys.join(",") || liveKeys.join(",") !== catalogKeys.join(",")) {
    throw new Error("stale estimatedOriginalMin catalog keys");
  }
  for (const name of catalogKeys) {
    const c = committed.estimatedOriginalMin[name];
    const l = live.estimatedOriginalMin[name];
    if (!c || !l) throw new Error(`missing estimatedOriginalMin ${name}`);
    if (c.provenance !== "estimated" || l.provenance !== "estimated") {
      throw new Error(`estimatedOriginalMin.${name} provenance must be estimated`);
    }
    if (c.value !== l.value) {
      throw new Error(`stale estimatedOriginalMin ${name} ${c.value} !== ${l.value}`);
    }
    if (c.gzipBytes !== l.gzipBytes) {
      throw new Error(`stale estimatedOriginalMin ${name} gzip`);
    }
  }

  const oracleC = committed.files.lodashOracleEntry;
  const oracleL = live.files.lodashOracleEntry;
  if (oracleL.bytes.provenance === "unavailable") {
    if (oracleC.bytes.provenance !== "unavailable") {
      throw new Error("lodashOracleEntry must be unavailable when the oracle is missing");
    }
    return;
  }
  if (oracleC.bytes.provenance !== "measured" || oracleC.gzipBytes.provenance !== "measured") {
    throw new Error("lodashOracleEntry provenance must be measured");
  }
  if (oracleC.bytes.value !== oracleL.bytes.value) {
    throw new Error(`stale lodashOracleEntry.bytes ${oracleC.bytes.value} !== ${oracleL.bytes.value}`);
  }
  if (oracleC.gzipBytes.value !== oracleL.gzipBytes.value) {
    throw new Error(`stale lodashOracleEntry.gzip ${oracleC.gzipBytes.value} !== ${oracleL.gzipBytes.value}`);
  }
  requireSha256(oracleC, "lodashOracleEntry");
  requireSha256(oracleL, "live lodashOracleEntry");
  if (oracleC.sha256 !== oracleL.sha256) {
    throw new Error(`stale lodashOracleEntry.sha256`);
  }
  requireMeasuredPositive(oracleC.parseNs, "lodashOracleEntry.parseNs");
  requireMeasuredPositive(oracleL.parseNs, "live lodashOracleEntry.parseNs");
}

export function writeClaims(doc: ClaimsDoc, root = ROOT): string {
  const out = join(root, "docs/measurements.json");
  writeFileSync(out, JSON.stringify(doc, null, 2) + "\n");
  return out;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const live = await measureClaims();
  if (process.argv.includes("--check")) {
    const committed = readCommittedClaims(ROOT);
    assertDocument("measurements", committed);
    assertClaimsCurrent(committed, live);
    process.stdout.write(
      `measurements check: current sliceBytes=${committed.files.goldenLodashSlice.bytes.value}\n`,
    );
  } else {
    assertDocument("measurements", live);
    const out = writeClaims(live);
    process.stdout.write(`wrote ${out} sliceBytes=${live.files.goldenLodashSlice.bytes.value}\n`);
  }
}
