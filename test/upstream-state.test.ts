import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EXIT_FAIL, SlimExit } from "../src/exit.ts";
import {
  replacementStateIssues,
  resolveReplacementPaths,
  type ReplacementRecord,
} from "../src/upstream/state.ts";
import {
  DEFAULT_HARDENING_SOURCE,
  DEFAULT_STANDING_SOURCE,
  minimalEnvelope,
  minimalEvidence,
  minimalManifest,
  rebindEvidenceArtifacts,
} from "./helpers/documents.ts";

const MODULE_SRC = "export function get() {}\nexport function set(o: unknown) { return o; }\n";

function plantComplete(
  root: string,
  opts: { envelopeRel?: string; moduleRel?: string; moduleSrc?: string } = {},
): { rec: ReplacementRecord; envelopeRel: string; moduleRel: string } {
  const pkg = "lodash";
  const env = minimalEnvelope(pkg, ["get", "set"]);
  const moduleRel = opts.moduleRel ?? "src/slim/lodash.ts";
  const envelopeRel = opts.envelopeRel ?? ".slim/lodash/envelope.json";
  mkdirSync(join(root, dirname(envelopeRel)), { recursive: true });
  mkdirSync(join(root, dirname(moduleRel)), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "up-state", type: "module", version: "1.0.0" }));
  writeFileSync(join(root, moduleRel), opts.moduleSrc ?? MODULE_SRC);
  writeFileSync(join(root, "src/slim/lodash.test.ts"), DEFAULT_STANDING_SOURCE);
  writeFileSync(join(root, "src/slim/lodash.hardened.test.ts"), DEFAULT_HARDENING_SOURCE);
  writeFileSync(join(root, envelopeRel), JSON.stringify(env, null, 2));
  const evidenceDir = join(root, dirname(envelopeRel));
  writeFileSync(join(evidenceDir, "evidence.json"), JSON.stringify(minimalEvidence(env)));
  mkdirSync(join(root, ".slim"), { recursive: true });
  const man = minimalManifest(env, moduleRel);
  writeFileSync(join(root, ".slim", "manifest.json"), JSON.stringify(man, null, 2));
  rebindEvidenceArtifacts(root, pkg, "src/slim", evidenceDir);
  return { rec: man.replacements.lodash, envelopeRel, moduleRel };
}

test("resolveReplacementPaths defaults envelope next to .slim/<pkg>", () => {
  const root = mkdtempSync(join(tmpdir(), "slim-paths-def-"));
  const { rec } = plantComplete(root);
  const paths = resolveReplacementPaths(root, "lodash", rec, { outDir: "src/slim" });
  assert.equal(paths.envelopeAbs, join(root, ".slim", "lodash", "envelope.json"));
  assert.equal(paths.evidenceAbs, join(root, ".slim", "lodash", "evidence.json"));
  assert.equal(paths.moduleAbs, join(root, "src/slim/lodash.ts"));
});

test("resolveReplacementPaths honors configured envelope and evidence sibling", () => {
  const root = mkdtempSync(join(tmpdir(), "slim-paths-cfg-"));
  const { rec } = plantComplete(root, { envelopeRel: "state/lodash/envelope.json" });
  const paths = resolveReplacementPaths(root, "lodash", rec, {
    outDir: "src/slim",
    envelope: "state/lodash/envelope.json",
  });
  assert.equal(paths.envelopeAbs, join(root, "state/lodash/envelope.json"));
  assert.equal(paths.evidenceAbs, join(root, "state/lodash/evidence.json"));
});

test("resolveReplacementPaths refuses an absolute configured envelope", () => {
  const root = mkdtempSync(join(tmpdir(), "slim-paths-abs-"));
  const { rec } = plantComplete(root);
  assert.throws(
    () =>
      resolveReplacementPaths(root, "lodash", rec, {
        outDir: "src/slim",
        envelope: "/tmp/evil/envelope.json",
      }),
    (e: unknown) =>
      e instanceof SlimExit && e.code === EXIT_FAIL && /unsafe state path/i.test(e.message) && /absolute/i.test(e.message),
  );
});

test("resolveReplacementPaths refuses a ../ module path", () => {
  const root = mkdtempSync(join(tmpdir(), "slim-paths-mod-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "up-state" }));
  const rec: ReplacementRecord = {
    version: "4.17.21",
    envelopeHash: "a".repeat(64),
    symbols: ["get"],
    module: "../outside.ts",
  };
  assert.throws(
    () => resolveReplacementPaths(root, "lodash", rec, { outDir: "src/slim" }),
    (e: unknown) =>
      e instanceof SlimExit && e.code === EXIT_FAIL && /unsafe state path/i.test(e.message),
  );
});

test("resolveReplacementPaths refuses a symlinked envelope", () => {
  const root = mkdtempSync(join(tmpdir(), "slim-paths-sym-"));
  const outside = mkdtempSync(join(tmpdir(), "slim-paths-sym-out-"));
  writeFileSync(join(outside, "envelope.json"), "{}\n");
  mkdirSync(join(root, ".slim", "lodash"), { recursive: true });
  symlinkSync(join(outside, "envelope.json"), join(root, ".slim", "lodash", "envelope.json"));
  const rec: ReplacementRecord = {
    version: "4.17.21",
    envelopeHash: "a".repeat(64),
    symbols: ["get"],
    module: "src/slim/lodash.ts",
  };
  mkdirSync(join(root, "src/slim"), { recursive: true });
  writeFileSync(join(root, "src/slim/lodash.ts"), MODULE_SRC);
  assert.throws(
    () => resolveReplacementPaths(root, "lodash", rec, { outDir: "src/slim" }),
    (e: unknown) =>
      e instanceof SlimExit && e.code === EXIT_FAIL && /unsafe state path/i.test(e.message),
  );
});

test("replacementStateIssues reads the configured envelope, not the default", () => {
  const root = mkdtempSync(join(tmpdir(), "slim-state-honor-"));
  const { rec } = plantComplete(root, { envelopeRel: "state/lodash/envelope.json" });
  const state = replacementStateIssues(root, "lodash", rec, {
    outDir: "src/slim",
    envelope: "state/lodash/envelope.json",
  });
  assert.equal(state.kind, "ok");
  assert.equal(state.drift.length, 0);
  assert.equal(state.envelope?.package.name, "lodash");
  assert.equal(state.paths?.envelopeAbs, join(root, "state/lodash/envelope.json"));
});

test("replacementStateIssues does not fall back to a default envelope when configured is missing", () => {
  const root = mkdtempSync(join(tmpdir(), "slim-state-nofall-"));
  const { rec } = plantComplete(root);
  const state = replacementStateIssues(root, "lodash", rec, {
    outDir: "src/slim",
    envelope: "state/lodash/envelope.json",
  });
  assert.equal(state.kind, "missing");
  assert.ok(state.drift.some((d) => /missing envelope/i.test(d.detail) && /state\/lodash\/envelope\.json/.test(d.detail)));
});

test("replacementStateIssues treats missing standing as missing-state", () => {
  const root = mkdtempSync(join(tmpdir(), "slim-state-stand-"));
  const { rec } = plantComplete(root);
  rmSync(join(root, "src/slim/lodash.test.ts"));
  const state = replacementStateIssues(root, "lodash", rec, { outDir: "src/slim" });
  assert.equal(state.kind, "missing");
  assert.ok(state.drift.some((d) => d.kind === "standing"));
});

test("replacementStateIssues treats missing hardening as missing-state", () => {
  const root = mkdtempSync(join(tmpdir(), "slim-state-hard-"));
  const { rec } = plantComplete(root);
  rmSync(join(root, "src/slim/lodash.hardened.test.ts"));
  const state = replacementStateIssues(root, "lodash", rec, { outDir: "src/slim" });
  assert.equal(state.kind, "missing");
  assert.ok(state.drift.some((d) => d.kind === "hardening"));
});

test("replacementStateIssues refuses a digest-rebound unsafe module before any source conclusion", () => {
  const root = mkdtempSync(join(tmpdir(), "slim-state-ast-"));
  const { rec } = plantComplete(root, {
    moduleSrc: 'export function get() { return eval("1"); }\nexport function set(o: unknown) { return o; }\n',
  });
  const state = replacementStateIssues(root, "lodash", rec, { outDir: "src/slim" });
  assert.equal(state.kind, "malformed");
  assert.ok(state.drift.some((d) => /AST allowlist|eval/i.test(d.detail)));
});

test("replacementStateIssues classifies a ../ module as malformed", () => {
  const root = mkdtempSync(join(tmpdir(), "slim-state-esc-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "up-state" }));
  mkdirSync(join(root, ".slim", "lodash"), { recursive: true });
  const rec: ReplacementRecord = {
    version: "4.17.21",
    envelopeHash: "a".repeat(64),
    symbols: ["get", "set"],
    module: "../secret.ts",
  };
  const state = replacementStateIssues(root, "lodash", rec, { outDir: "src/slim" });
  assert.equal(state.kind, "malformed");
  assert.ok(state.drift.some((d) => /unsafe state path/i.test(d.detail)));
});
