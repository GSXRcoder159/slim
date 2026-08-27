import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeEnvelope } from "../src/envelope/close.ts";
import { renderEvidenceMd, writeEvidence, type EvidenceJson } from "../src/evidence/report.ts";
import { findBundleEntry, maybeBundleBytes } from "../src/size/bundle.ts";
import { ENVELOPE_VERSION, emptyHyrum } from "../src/envelope/types.ts";
import type { Envelope } from "../src/envelope/types.ts";
import type { RevertPlan } from "../src/rewrite/revert.ts";

function sampleRevert(pkg = "lodash"): RevertPlan {
  return {
    package: pkg,
    version: "1.0.0",
    module: `src/slim/${pkg}.ts`,
    tests: `src/slim/${pkg}.test.ts`,
    cjsCompanion: null,
    rewrites: [{ file: "src/index.ts", original: pkg, replacement: `./slim/${pkg}.ts` }],
    lockfile: "npm",
    installCommand: "npm install",
  };
}

function env(family = "lodash"): Envelope {
  return {
    schemaVersion: ENVELOPE_VERSION,
    package: { name: family === "lodash" ? "lodash" : "ms", version: "1.0.0", family, subpath: "" },
    env: ["node"],
    imports: [],
    symbols: [
      {
        exportName: "get",
        packages: [],
        callSites: [],
        resultMembers: [],
        hyrum: emptyHyrum(),
        coverage: { callSitesStatic: 0, callSitesTraced: 0 },
      },
    ],
    unknowns: [],
    traces: [],
    closure: {
      confidence: "closed",
      readyToGenerate: true,
      staticCallSiteIds: [],
      tracedCallSiteIds: [],
      untracedCallSiteIds: [],
      reason: "",
    },
    slimmable: { score: 80, verdict: "slim", blockers: [], reasons: [] },
    clock: false,
    cryptoRandom: false,
  };
}

const fuzz: EvidenceJson["fuzz"] = {
  cases: 1,
  comparisons: 1,
  timerCases: 0,
  tracesReplayed: 2,
  wallMs: 10,
  seed: 1,
  disagreements: 0,
};

test("evidence markdown has sections 1 through 8 in order", () => {
  const json: EvidenceJson = {
    schemaVersion: 1,
    slogan: "EVIDENCE, NOT PROOF",
    package: env().package,
    envelopeHash: "abc",
    symbols: ["get"],
    callSites: 1,
    unknowns: 0,
    byteDelta: { originalMin: 71000, replacement: 6981, gzipOriginal: 25560 },
    fuzz,
    coverageHoles: ["zero traces replayed"],
    residualRisk: ["always"],
    revert: sampleRevert(),
  };
  const md = renderEvidenceMd(json, env(), ["lodash.get"]);
  assert.match(md, /^# EVIDENCE, NOT PROOF/m);
  assert.match(md, /^## 1\. Evidence, not proof/m);
  assert.match(md, /^## 2\. What was used/m);
  assert.match(md, /^## 3\. Byte delta/m);
  assert.match(md, /^## 4\. Edge/m);
  assert.match(md, /^## 5\. Fuzz/m);
  assert.match(md, /^## 6\. Coverage holes/m);
  assert.match(md, /^## 7\. Upstream pin/m);
  assert.match(md, /^## 8\. How to revert/m);
  assert.doesNotMatch(md, /^## 9\./m);
});

test("Edge is n/a for non-lodash families", () => {
  const e = env("ms");
  const json: EvidenceJson = {
    schemaVersion: 1,
    slogan: "EVIDENCE, NOT PROOF",
    package: e.package,
    envelopeHash: "abc",
    symbols: ["ms"],
    callSites: 1,
    unknowns: 0,
    byteDelta: { originalMin: null, replacement: 100, gzipOriginal: null },
    fuzz,
    coverageHoles: [],
    residualRisk: ["always"],
    revert: sampleRevert(),
  };
  const md = renderEvidenceMd(json, e, []);
  assert.match(md, /## 4\. Edge\n\nn\/a/);
});

test("byte delta includes esbuild dry-run line when bundle is present", () => {
  const json: EvidenceJson = {
    schemaVersion: 1,
    slogan: "EVIDENCE, NOT PROOF",
    package: env().package,
    envelopeHash: "abc",
    symbols: ["get"],
    callSites: 1,
    unknowns: 0,
    byteDelta: {
      originalMin: 71000,
      replacement: 6981,
      gzipOriginal: 25560,
      bundle: { tool: "esbuild", bytes: 1234, entry: "src/index.ts" },
    },
    fuzz,
    coverageHoles: [],
    residualRisk: ["always"],
    revert: sampleRevert(),
  };
  const md = renderEvidenceMd(json, env(), []);
  assert.match(md, /esbuild dry-run of `src\/index\.ts`: 1234 B/);
});

test("writeEvidence residual risk is never empty", () => {
  const root = mkdtempSync(join(tmpdir(), "slim-ev-"));
  const { mdPath } = writeEvidence({
    root,
    env: env(),
    replacementBytes: 100,
    originalMin: 1000,
    fuzz,
    catalogIds: [],
    coverageHoles: [],
    bundle: null,
    revert: sampleRevert(),
  });
  const md = readFileSync(mdPath, "utf8");
  assert.match(md, /## Residual risk/);
  assert.match(md, /strong evidence, not proof/);
});

test("zero traces cannot claim trace-closed and residual risk names unobserved runtime", () => {
  const closed = closeEnvelope(env());
  assert.notEqual(closed.closure.confidence, "trace-closed");
  assert.match(closed.closure.reason, /runtime distribution/);
  const root = mkdtempSync(join(tmpdir(), "slim-ev-static-"));
  const { mdPath } = writeEvidence({
    root,
    env: closed,
    replacementBytes: 100,
    originalMin: 1000,
    fuzz: { ...fuzz, tracesReplayed: 0 },
    catalogIds: [],
    coverageHoles: ["zero traces replayed"],
    bundle: null,
    revert: sampleRevert(),
  });
  const md = readFileSync(mdPath, "utf8");
  assert.match(md, /runtime distribution was not observed|not your runtime distribution/);
  assert.doesNotMatch(md, /trace-closed/);
});

test("allow-flaky evidence is marked not production-ready", () => {
  const root = mkdtempSync(join(tmpdir(), "slim-ev-flaky-"));
  const cryptoEnv = env();
  cryptoEnv.cryptoRandom = true;
  cryptoEnv.package = { name: "chance", version: "1.0.0", family: "chance", subpath: "." };
  const { mdPath, jsonPath } = writeEvidence({
    root,
    env: cryptoEnv,
    replacementBytes: 100,
    originalMin: 1000,
    fuzz: { ...fuzz, allowFlaky: true },
    catalogIds: [],
    coverageHoles: [],
    bundle: null,
    revert: sampleRevert("chance"),
  });
  const md = readFileSync(mdPath, "utf8");
  const json = JSON.parse(readFileSync(jsonPath, "utf8")) as { fuzz: { allowFlaky?: boolean }; residualRisk: string[] };
  assert.equal(json.fuzz.allowFlaky, true);
  assert.match(md, /not production-ready/);
  assert.ok(json.residualRisk.some((x) => /allow-flaky/i.test(x) && /not production-ready/i.test(x)));
});

test("LLM evidence records provenance and redacts secrets", () => {
  const root = mkdtempSync(join(tmpdir(), "slim-ev-llm-"));
  const { mdPath, jsonPath } = writeEvidence({
    root,
    env: env("ms"),
    replacementBytes: 100,
    originalMin: 1000,
    fuzz,
    catalogIds: [],
    coverageHoles: [],
    bundle: null,
    revert: sampleRevert("ms"),
    generation: {
      kind: "llm",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      promptHash: "abc123",
      attempts: 2,
      specSource: "envelope-only",
      limitation: "no local .d.ts or README",
      counterexamples: ["ms: 1 !== 1000 args=[\"1s\"]"],
    },
  });
  const json = JSON.parse(readFileSync(jsonPath, "utf8")) as EvidenceJson;
  const md = readFileSync(mdPath, "utf8");
  assert.equal(json.generation?.kind, "llm");
  assert.equal(json.generation?.provider, "anthropic");
  assert.equal(json.generation?.model, "claude-sonnet-4-5");
  assert.equal(json.generation?.promptHash, "abc123");
  assert.equal(json.generation?.attempts, 2);
  assert.equal(json.generation?.specSource, "envelope-only");
  assert.equal(json.generation?.counterexamples.length, 1);
  assert.match(md, /Generation: LLM \(anthropic \/ claude-sonnet-4-5\)/);
  assert.match(md, /Prompt hash: `abc123`/);
  assert.match(md, /Attempts: 2/);
  assert.doesNotMatch(md, /sk-ant-|sk-secret|ANTHROPIC_API_KEY/);
  assert.doesNotMatch(jsonPath, /lodash\.js/);
  assert.doesNotMatch(JSON.stringify(json), /function get\(object, path/);
});

test("catalog evidence has kind catalog and empty counterexamples", () => {
  const root = mkdtempSync(join(tmpdir(), "slim-ev-cat-"));
  const { jsonPath } = writeEvidence({
    root,
    env: env(),
    replacementBytes: 100,
    originalMin: 1000,
    fuzz,
    catalogIds: ["lodash.get"],
    coverageHoles: [],
    bundle: null,
    revert: sampleRevert(),
  });
  const json = JSON.parse(readFileSync(jsonPath, "utf8")) as EvidenceJson;
  assert.equal(json.generation?.kind, "catalog");
  assert.deepEqual(json.generation?.catalogIds, ["lodash.get"]);
  assert.deepEqual(json.generation?.counterexamples, []);
  assert.equal(json.generation?.specSource, "catalog");
});

test("writeEvidence records evidence hash and module digest in markdown", () => {
  const root = mkdtempSync(join(tmpdir(), "slim-ev-dig-"));
  mkdirSync(join(root, "src", "slim"), { recursive: true });
  writeFileSync(join(root, "src", "slim", "lodash.ts"), "export function get() { return 1; }\n");
  const { mdPath, jsonPath } = writeEvidence({
    root,
    env: env(),
    replacementBytes: 100,
    originalMin: 1000,
    fuzz,
    catalogIds: ["lodash.get"],
    coverageHoles: [],
    bundle: null,
    revert: sampleRevert(),
  });
  const md = readFileSync(mdPath, "utf8");
  const jsonBytes = readFileSync(jsonPath);
  const modBytes = readFileSync(join(root, "src", "slim", "lodash.ts"));
  const evidenceHash = createHash("sha256").update(jsonBytes).digest("hex");
  const moduleDigest = createHash("sha256").update(modBytes).digest("hex");
  assert.match(md, new RegExp(`Evidence hash: \`${evidenceHash}\``));
  assert.match(md, new RegExp(`Module digest: \`${moduleDigest}\``));
});


test("findBundleEntry reads wrangler.toml main", () => {
  const root = mkdtempSync(join(tmpdir(), "slim-bdl-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "worker.ts"), "export default {}\n");
  writeFileSync(join(root, "wrangler.toml"), 'main = "src/worker.ts"\n');
  assert.equal(findBundleEntry(root), "src/worker.ts");
});

test("maybeBundleBytes uses esbuild when wrangler is absent", () => {
  const root = mkdtempSync(join(tmpdir(), "slim-esb-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "index.ts"), "export const x = 1;\n");
  const dir = mkdtempSync(join(tmpdir(), "slim-esb-out-"));
  writeFileSync(join(dir, "bundle.js"), "export const x=1;");
  const delta = maybeBundleBytes(root, {
    hasBin: (n) => n === "esbuild",
    tmpDir: () => dir,
    execFile: () => "",
  });
  assert.ok(delta);
  assert.equal(delta!.tool, "esbuild");
  assert.equal(delta!.entry, "src/index.ts");
  assert.ok(delta!.bytes > 0);
});

test("maybeBundleBytes returns null when neither tool is on PATH", () => {
  const root = mkdtempSync(join(tmpdir(), "slim-none-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "index.ts"), "export const x = 1;\n");
  assert.equal(maybeBundleBytes(root, { hasBin: () => false }), null);
});
