import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hashEnvelope, type Envelope } from "../src/envelope/types.ts";
import type { EvidenceJson } from "../src/evidence/report.ts";
import {
  GOLDEN_REFRESH_INPUTS,
  assertGoldenInputs,
  goldenEquivalent,
} from "../scripts/refresh-golden-fixture.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(ROOT, "fixtures", "lodash-get-debounce");
const SLIM = join(FIXTURE, ".slim", "lodash");

function gitLf(buf: Buffer): Buffer {
  return Buffer.from(buf.toString("utf8").replace(/\r\n/g, "\n"));
}

test("refresh-inputs.json matches the declared golden contract", () => {
  const path = join(FIXTURE, ".slim", "refresh-inputs.json");
  assert.ok(existsSync(path), "fixtures/lodash-get-debounce/.slim/refresh-inputs.json must exist");
  const got = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  for (const [key, value] of Object.entries(GOLDEN_REFRESH_INPUTS)) {
    assert.equal(got[key], value, `refresh-inputs.${key}`);
  }
  assert.equal(GOLDEN_REFRESH_INPUTS.seed, 1);
  assert.equal(GOLDEN_REFRESH_INPUTS.workers, 1);
  assert.equal(GOLDEN_REFRESH_INPUTS.budgetMs, 30000);
  assert.equal(GOLDEN_REFRESH_INPUTS.templateOnly, true);
  assert.equal(GOLDEN_REFRESH_INPUTS.node, "22.18");
  assert.equal(GOLDEN_REFRESH_INPUTS.os, "linux");
  assert.deepEqual(assertGoldenInputs(FIXTURE), []);
});

test("assertGoldenInputs fails when lockfile seed budget env or artifact identity drifts", () => {
  const work = mkdtempSync(join(tmpdir(), "slim-golden-stale-"));
  const copy = (rel: string) => {
    const dest = join(work, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, readFileSync(join(FIXTURE, rel)));
  };
  for (const rel of [
    "package-lock.json",
    ".slim/refresh-inputs.json",
    ".slim/lodash/envelope.json",
    ".slim/lodash/evidence.json",
    "src/slim/lodash.ts",
    "src/slim/lodash.test.ts",
    "src/slim/lodash.hardened.test.ts",
  ]) {
    copy(rel);
  }
  assert.deepEqual(assertGoldenInputs(work), []);

  const inputsPath = join(work, ".slim", "refresh-inputs.json");
  const inputs = JSON.parse(readFileSync(inputsPath, "utf8")) as Record<string, unknown>;

  writeFileSync(join(work, "package-lock.json"), "{}\n");
  assert.ok(assertGoldenInputs(work).some((m) => /lockfile/i.test(m)));
  writeFileSync(join(work, "package-lock.json"), readFileSync(join(FIXTURE, "package-lock.json")));

  writeFileSync(inputsPath, JSON.stringify({ ...inputs, seed: 99 }) + "\n");
  assert.ok(assertGoldenInputs(work).some((m) => /seed/i.test(m)));
  writeFileSync(inputsPath, JSON.stringify({ ...inputs, budgetMs: 1 }) + "\n");
  assert.ok(assertGoldenInputs(work).some((m) => /budget/i.test(m)));
  writeFileSync(inputsPath, JSON.stringify({ ...inputs, node: "24" }) + "\n");
  assert.ok(assertGoldenInputs(work).some((m) => /node/i.test(m)));
  writeFileSync(inputsPath, JSON.stringify({ ...inputs, os: "darwin" }) + "\n");
  assert.ok(assertGoldenInputs(work).some((m) => /\bos\b/i.test(m)));
  writeFileSync(inputsPath, JSON.stringify({ ...inputs, fixtureRevision: "0".repeat(64) }) + "\n");
  assert.ok(assertGoldenInputs(work).some((m) => /fixtureRevision/i.test(m)));
  writeFileSync(inputsPath, JSON.stringify({ ...inputs, moduleDigest: "0".repeat(64) }) + "\n");
  assert.ok(assertGoldenInputs(work).some((m) => /moduleDigest/i.test(m)));
  writeFileSync(inputsPath, JSON.stringify(inputs) + "\n");

  writeFileSync(join(work, "src", "slim", "lodash.ts"), "export function get() { return 2; }\n");
  assert.ok(assertGoldenInputs(work).some((m) => /moduleDigest/i.test(m)));
});

test("refresh:golden pins seed workers template-only and excludes traces.jsonl", () => {
  const src = readFileSync(join(ROOT, "scripts", "refresh-golden-fixture.ts"), "utf8");
  assert.match(src, /"--seed"/);
  assert.match(src, /"--workers"/);
  assert.match(src, /"--template-only"/);
  assert.match(src, /"--budget-ms"/);
  assert.match(src, /node: "22\.18"/);
  assert.match(src, /os: "linux"/);
  assert.match(src, /traces\.jsonl/);
  assert.doesNotMatch(src, /copyIfExists\([^)]*traces\.jsonl/);
});

test("committed golden evidence matches refresh inputs, slice bytes, and catalog generation", () => {
  const evidence = JSON.parse(readFileSync(join(SLIM, "evidence.json"), "utf8")) as EvidenceJson;
  const env = JSON.parse(readFileSync(join(SLIM, "envelope.json"), "utf8")) as Envelope;
  const man = JSON.parse(readFileSync(join(FIXTURE, ".slim", "manifest.json"), "utf8")) as {
    replacements: { lodash: { envelopeHash: string; version: string } };
  };
  const slice = gitLf(readFileSync(join(FIXTURE, "src", "slim", "lodash.ts")));
  assert.equal(evidence.fuzz.seed, GOLDEN_REFRESH_INPUTS.seed);
  assert.equal(evidence.package.version, GOLDEN_REFRESH_INPUTS.lodashVersion);
  assert.equal(evidence.package.name, GOLDEN_REFRESH_INPUTS.package);
  assert.equal(evidence.generation?.kind, "catalog");
  assert.equal(evidence.byteDelta.replacement, slice.byteLength);
  const hash = hashEnvelope(env);
  assert.equal(evidence.envelopeHash, hash);
  assert.equal(man.replacements.lodash.envelopeHash, hash);
  assert.equal(man.replacements.lodash.version, GOLDEN_REFRESH_INPUTS.lodashVersion);
  const standing = gitLf(readFileSync(join(FIXTURE, "src", "slim", "lodash.test.ts")));
  const hardening = gitLf(readFileSync(join(FIXTURE, "src", "slim", "lodash.hardened.test.ts")));
  assert.equal(evidence.artifacts.moduleDigest, createHash("sha256").update(slice).digest("hex"));
  assert.equal(evidence.artifacts.standingDigest, createHash("sha256").update(standing).digest("hex"));
  assert.equal(evidence.artifacts.hardeningDigest, createHash("sha256").update(hardening).digest("hex"));
  assert.equal(evidence.artifacts.oracleVersion, GOLDEN_REFRESH_INPUTS.lodashVersion);
  assert.equal(
    evidence.artifacts.fixtureRevision,
    createHash("sha256").update(Buffer.concat([standing, Buffer.from([0]), hardening])).digest("hex"),
  );
});

test("golden evidence.md has real digests and the sample is a true copy", () => {
  const md = gitLf(readFileSync(join(SLIM, "evidence.md"))).toString("utf8");
  const sample = gitLf(readFileSync(join(ROOT, "docs", "evidence.lodash.sample.md"))).toString("utf8");
  assert.equal(sample, md, "docs/evidence.lodash.sample.md must equal golden evidence.md");
  const jsonBytes = gitLf(readFileSync(join(SLIM, "evidence.json")));
  const modBytes = gitLf(readFileSync(join(FIXTURE, "src", "slim", "lodash.ts")));
  const evidenceHash = createHash("sha256").update(jsonBytes).digest("hex");
  const moduleDigest = createHash("sha256").update(modBytes).digest("hex");
  assert.match(md, new RegExp(`Evidence hash: \`${evidenceHash}\``));
  assert.match(md, new RegExp(`Module digest: \`${moduleDigest}\``));
  assert.doesNotMatch(md, /Evidence hash: `0{64}`/);
  assert.doesNotMatch(md, /Module digest: `1{64}`/);
});

test("goldenEquivalent reports identity fields and ignores wall-clock fuzz stats", () => {
  const a = mkdtempSync(join(tmpdir(), "slim-geq-a-"));
  const b = mkdtempSync(join(tmpdir(), "slim-geq-b-"));
  const files: Record<string, string> = {
    ".slim/lodash/envelope.json": '{"ok":true}\n',
    "src/slim/lodash.ts": "export function get() {}\n",
    "src/slim/lodash.test.ts": "test('standing', () => {});\n",
    "src/slim/lodash.hardened.test.ts": "test('hardened', () => {});\n",
    "src/index.ts": 'export { get } from "./slim/lodash.ts";\n',
    "slim.json": "{}\n",
  };
  const evidence = {
    package: { name: "lodash", version: "4.17.21" },
    envelopeHash: "aa",
    byteDelta: { replacement: 24 },
    generation: { kind: "catalog" },
    artifacts: {
      moduleDigest: "11",
      standingDigest: "22",
      hardeningDigest: "33",
      fixtureRevision: "44",
    },
    fuzz: {
      seed: 1,
      tracesReplayed: 12,
      disagreements: 0,
      wallMs: 100,
      cases: 10,
      comparisons: 10,
    },
  };
  for (const dest of [a, b]) {
    mkdirSync(join(dest, ".slim", "lodash"), { recursive: true });
    mkdirSync(join(dest, "src", "slim"), { recursive: true });
    for (const [rel, body] of Object.entries(files)) {
      writeFileSync(join(dest, rel), body);
    }
    writeFileSync(join(dest, ".slim", "lodash", "evidence.json"), JSON.stringify(evidence) + "\n");
  }
  const bEv = {
    ...evidence,
    fuzz: { ...evidence.fuzz, wallMs: 999, cases: 99, comparisons: 99 },
  };
  writeFileSync(join(b, ".slim", "lodash", "evidence.json"), JSON.stringify(bEv) + "\n");
  assert.deepEqual(goldenEquivalent(a, b), []);

  writeFileSync(join(b, "src", "slim", "lodash.ts"), "export function get() { return 1; }\n");
  bEv.fuzz.seed = 2;
  bEv.artifacts = { ...bEv.artifacts, moduleDigest: "99" };
  writeFileSync(join(b, ".slim", "lodash", "evidence.json"), JSON.stringify(bEv) + "\n");
  const mismatches = goldenEquivalent(a, b);
  assert.ok(mismatches.includes("src/slim/lodash.ts"));
  assert.ok(mismatches.includes("evidence.fuzz.seed"));
  assert.ok(mismatches.includes("evidence.artifacts.moduleDigest"));
});
