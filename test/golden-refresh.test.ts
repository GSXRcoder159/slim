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
  const got = JSON.parse(readFileSync(path, "utf8")) as typeof GOLDEN_REFRESH_INPUTS;
  assert.deepEqual(got, {
    seed: 1,
    workers: 1,
    budgetMs: 30000,
    templateOnly: true,
    lodashVersion: "4.17.21",
    package: "lodash",
  });
  assert.equal(GOLDEN_REFRESH_INPUTS.seed, 1);
  assert.equal(GOLDEN_REFRESH_INPUTS.workers, 1);
  assert.equal(GOLDEN_REFRESH_INPUTS.budgetMs, 30000);
  assert.equal(GOLDEN_REFRESH_INPUTS.templateOnly, true);
});

test("refresh:golden pins seed workers template-only and excludes traces.jsonl", () => {
  const src = readFileSync(join(ROOT, "scripts", "refresh-golden-fixture.ts"), "utf8");
  assert.match(src, /"--seed"/);
  assert.match(src, /"--workers"/);
  assert.match(src, /"--template-only"/);
  assert.match(src, /"--budget-ms"/);
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
  writeFileSync(join(b, ".slim", "lodash", "evidence.json"), JSON.stringify(bEv) + "\n");
  const mismatches = goldenEquivalent(a, b);
  assert.ok(mismatches.includes("src/slim/lodash.ts"));
  assert.ok(mismatches.includes("evidence.fuzz.seed"));
});
