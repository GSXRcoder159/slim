import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  GOLDEN_SLICE,
  MAX_HITS,
  NGRAM_N,
  exclusionIds,
  listOracleRels,
  requiredTargetRels,
  runSimilarityGate,
} from "../scripts/similarity.ts";
import { getCatalog } from "../src/generate/catalog/index.ts";
import { catalogBoundary } from "../src/generate/catalog/boundary.ts";
import { catalogEnvelope } from "./catalog/qualify-helpers.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = tmpdir();

test("similarity gate passes against all pinned catalog oracles with classified exclusions", () => {
  const r = runSimilarityGate();
  assert.equal(r.ok, true, r.failed);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.excluded, exclusionIds());
  assert.ok(!r.excluded.some((e) => e.includes(":fp") || e.endsWith("/fp/")));
  const rels = listOracleRels();
  assert.ok(
    rels.some((p) => p.includes("moment/src/lib/locale/")),
    "moment locale engine must be scanned",
  );
  assert.ok(
    rels.some((p) => p.includes("lodash/fp/")),
    "lodash fp/ must be scanned",
  );
  assert.ok(
    !rels.some((p) => /(^|\/)moment\/locale\//.test(p)),
    "moment locale data packs must be excluded",
  );
  assert.equal(getCatalog("moment", "default")?.supports?.locales, false);
  const env = catalogEnvelope({
    name: "moment",
    version: "2.30.1",
    symbols: ["default"],
    resultMembers: { default: ["format", "locale"] },
  });
  const boundary = catalogBoundary(env, "moment");
  assert.ok(boundary);
  assert.equal(boundary.why, "envelope-too-wide");
  assert.match(boundary.evidence, /locale/);
  assert.ok(existsSync(join(ROOT, GOLDEN_SLICE)));
  const required = requiredTargetRels();
  assert.ok(required.includes(GOLDEN_SLICE));
  assert.ok(required.includes("src/generate/catalog/lodash.get.ts"));
  assert.ok(!required.includes("src/generate/catalog/lodash.first.ts"));
  for (const rel of required) {
    assert.ok(existsSync(join(ROOT, rel)), `required target missing on disk: ${rel}`);
    assert.ok(r.targets.includes(rel), `full run omitted required target ${rel}`);
  }
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

test("similarity gate fails when catalog and golden targets are empty", () => {
  mkdirSync(TMP, { recursive: true });
  const tmp = mkdtempSync(join(TMP, "slim-sim-empty-"));
  try {
    mkdirSync(join(tmp, "src/generate/catalog"), { recursive: true });
    mkdirSync(join(tmp, "node_modules/ms"), { recursive: true });
    writeFileSync(join(tmp, "node_modules/ms/index.js"), "module.exports = 1;\n");
    const r = runSimilarityGate({ root: tmp, oraclePkgs: ["ms"] });
    assert.equal(r.ok, false);
    assert.match(r.failed ?? "", /no catalog or slice targets|empty target/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("similarity gate fails when a classified exclusion matches nothing", () => {
  mkdirSync(TMP, { recursive: true });
  const tmp = mkdtempSync(join(TMP, "slim-sim-stale-"));
  try {
    mkdirSync(join(tmp, "src/generate/catalog"), { recursive: true });
    writeFileSync(join(tmp, "src/generate/catalog/ok.ts"), "export const ok = 1;\n");
    mkdirSync(join(tmp, "node_modules/moment"), { recursive: true });
    writeFileSync(join(tmp, "node_modules/moment/moment.js"), "exports.x = 1;\n");
    const r = runSimilarityGate({ root: tmp, oraclePkgs: ["moment"] });
    assert.equal(r.ok, false);
    assert.match(r.failed ?? "", /stale exclusion|matched nothing/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("similarity gate does not skip unclassified locale directories", () => {
  mkdirSync(TMP, { recursive: true });
  const tmp = mkdtempSync(join(TMP, "slim-sim-ms-locale-"));
  try {
    const words = Array.from({ length: 20 }, (_, i) => `msLocaleTok${i}xyz`);
    const body = words.join(" ") + ";\n";
    mkdirSync(join(tmp, "src/generate/catalog"), { recursive: true });
    writeFileSync(join(tmp, "src/generate/catalog/copied.ts"), body);
    mkdirSync(join(tmp, "node_modules/ms/locale"), { recursive: true });
    writeFileSync(join(tmp, "node_modules/ms/locale/data.js"), body);
    const r = runSimilarityGate({ root: tmp, oraclePkgs: ["ms"] });
    assert.equal(r.ok, false, "unclassified locale/ under ms must still be scanned");
    assert.ok((r.worst ?? 0) > MAX_HITS);
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

test("similarity gate worstFile and targets are stable across two runs", () => {
  const a = runSimilarityGate();
  const b = runSimilarityGate();
  assert.equal(a.ok, b.ok);
  assert.equal(a.worst, b.worst);
  assert.equal(a.worstFile, b.worstFile);
  assert.deepEqual(a.excluded, b.excluded);
  assert.deepEqual(a.targets, b.targets);
});

test("similarity gate fails when a required catalog target is missing", () => {
  mkdirSync(TMP, { recursive: true });
  const tmp = mkdtempSync(join(TMP, "slim-sim-required-"));
  try {
    mkdirSync(join(tmp, "src/generate/catalog"), { recursive: true });
    writeFileSync(join(tmp, "src/generate/catalog/lodash.set.ts"), "export const set = 1;\n");
    mkdirSync(join(tmp, "node_modules/ms"), { recursive: true });
    writeFileSync(join(tmp, "node_modules/ms/index.js"), "module.exports = 1;\n");
    const r = runSimilarityGate({
      root: tmp,
      oraclePkgs: ["ms"],
      requiredRels: ["src/generate/catalog/lodash.get.ts", "src/generate/catalog/lodash.set.ts"],
    });
    assert.equal(r.ok, false);
    assert.match(r.failed ?? "", /missing required target src\/generate\/catalog\/lodash\.get\.ts/);
    assert.ok(r.targets.includes("src/generate/catalog/lodash.set.ts"));
    assert.ok(!r.targets.includes("src/generate/catalog/lodash.get.ts"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
