import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeEvidence } from "../../src/evidence/report.ts";
import { REPLACE_PR_LABELS, type CreatePrOpts } from "../../src/github/pr.ts";
import { withArtifactDigest } from "../../src/github/pr-transaction.ts";
import { fileBase } from "../../src/rewrite/paths.ts";
import { minimalEnvelope, minimalManifest, plantReplacementTree } from "./documents.ts";

export const TEST_ARTIFACT_DIGEST = "b".repeat(64);

export function plantReplaceTxn(opts?: { pkg?: string; root?: string }): CreatePrOpts & { pkg: string } {
  const pkg = opts?.pkg ?? "lodash";
  const root = opts?.root ?? mkdtempSync(join(tmpdir(), "slim-pr-txn-"));
  const env = minimalEnvelope(pkg);
  const moduleRel = `src/slim/${fileBase(pkg)}.ts`;
  mkdirSync(join(root, "src", "slim"), { recursive: true });
  mkdirSync(join(root, ".slim", pkg), { recursive: true });
  writeFileSync(join(root, moduleRel), "export function get() { return 1; }\n");
  plantReplacementTree(root, { pkg, moduleRel, module: "export function get() { return 1; }\n" });
  writeFileSync(join(root, ".slim", pkg, "envelope.json"), JSON.stringify(env, null, 2) + "\n");
  writeFileSync(join(root, ".slim", "manifest.json"), JSON.stringify(minimalManifest(env, moduleRel), null, 2) + "\n");
  writeEvidence({
    root,
    env,
    replacementBytes: 32,
    originalMin: 1000,
    fuzz: {
      cases: 10,
      comparisons: 10,
      timerCases: 0,
      tracesReplayed: 0,
      wallMs: 1,
      seed: 141647386,
      disagreements: 0,
    },
    catalogIds: pkg === "lodash" ? ["lodash.get"] : [`${pkg}.ms`],
    coverageHoles: ["debounce options never observed"],
    bundle: null,
    revert: {
      package: pkg,
      version: env.package.version,
      module: moduleRel,
      tests: `src/slim/${fileBase(pkg)}.test.ts`,
      cjsCompanion: null,
      rewrites: [],
      lockfile: "npm",
      installCommand: "npm install",
    },
  });
  const body = withArtifactDigest(
    readFileSync(join(root, ".slim", pkg, "evidence.md"), "utf8"),
    TEST_ARTIFACT_DIGEST,
  );
  return {
    root,
    pkg,
    title: `slim: replace ${pkg} with a verified slice`,
    body,
    branch: `slim/${fileBase(pkg)}`,
    files: [
      moduleRel,
      `.slim/${pkg}/evidence.md`,
      `.slim/${pkg}/evidence.json`,
      `.slim/${pkg}/envelope.json`,
    ],
    labels: [...REPLACE_PR_LABELS],
    kind: "replace",
    artifactDigest: TEST_ARTIFACT_DIGEST,
  };
}
