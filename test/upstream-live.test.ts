import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { npmContentDigest } from "../src/release/digest.ts";
import { canonicalInventory } from "../src/support/inventory.ts";
import { sourceReceipt, writeReceipt } from "../src/support/receipts.ts";
import { installFixture, packSlim, ROOT, runSlim } from "./helpers/llm-replace.ts";
import { minimalEnvelope, minimalEvidence, minimalManifest, rebindEvidenceArtifacts } from "./helpers/documents.ts";

const LIVE = process.env.SLIM_UPSTREAM_LIVE === "1";
// OSV omits `vulns` on empty HTTP 200 `{}`. Slim treats that as malformed.
// Live proof needs a current latest whose query returns a vulns array (request@2.88.2).
const FIXTURE = "request-watch";

let packDir = "";
let tarball = "";
let npmDigest: string | null = null;

before(() => {
  if (!LIVE) return;
  const packed = packSlim();
  packDir = packed.packDir;
  tarball = packed.tarball;
  npmDigest = npmContentDigest(tarball);
});

after(() => {
  if (packDir) rmSync(packDir, { recursive: true, force: true });
});

function linkTypescript(root: string): void {
  const tsDir = dirname(createRequire(import.meta.url).resolve("typescript/package.json"));
  mkdirSync(join(root, "node_modules"), { recursive: true });
  const dest = join(root, "node_modules", "typescript");
  if (!existsSync(dest)) symlinkSync(tsDir, dest);
}

function writeWatchFixture(dest: string): void {
  const env = minimalEnvelope("request", ["noop"], "2.88.2");
  mkdirSync(join(dest, ".slim", "request"), { recursive: true });
  mkdirSync(join(dest, "src", "slim"), { recursive: true });
  writeFileSync(
    join(dest, "package.json"),
    JSON.stringify({ name: "request-watch", private: true, type: "module", version: "1.0.0" }),
  );
  writeFileSync(join(dest, ".slim", "manifest.json"), JSON.stringify(minimalManifest(env), null, 2));
  writeFileSync(join(dest, ".slim", "request", "envelope.json"), JSON.stringify(env, null, 2));
  writeFileSync(
    join(dest, ".slim", "request", "evidence.json"),
    JSON.stringify(
      minimalEvidence(env, {
        generation: {
          kind: "catalog",
          catalogIds: ["request.noop"],
          attempts: 1,
          specSource: "catalog",
          counterexamples: [],
        },
      }),
    ),
  );
  writeFileSync(join(dest, "src", "slim", "request.ts"), "export function noop(): void {}\n");
  writeFileSync(
    join(dest, "src", "slim", "request.test.ts"),
    `import { test } from "node:test";\ntest("standing", () => {});\n`,
  );
  writeFileSync(
    join(dest, "src", "slim", "request.hardened.test.ts"),
    `import { test } from "node:test";\ntest("hardened", () => {});\n`,
  );
  rebindEvidenceArtifacts(dest, "request", "src/slim");
}

test("support inventory advertises osv and npm-registry as required live sources", () => {
  const services = canonicalInventory().entries.filter((e) => e.kind === "externalService" && (e.name === "osv" || e.name === "npm-registry"));
  assert.deepEqual(
    services.map((s) => s.name).sort(),
    ["npm-registry", "osv"],
  );
  for (const s of services) {
    assert.equal(s.receiptClass, "live");
    assert.equal(s.checkId, "test/upstream-live.test.ts");
  }
});

test("live packed upstream consults OSV and npm", { timeout: 180_000 }, async () => {
  if (!LIVE) {
    assert.equal(process.env.SLIM_UPSTREAM_LIVE ?? "", "", "live tests stay registered when SLIM_UPSTREAM_LIVE is unset");
    return;
  }
  const dest = mkdtempSync(join(tmpdir(), "slim-upstream-live-"));
  const startedAt = new Date();
  try {
    writeWatchFixture(dest);
    const slimJs = installFixture(dest, tarball);
    linkTypescript(dest);
    const digest = process.env.SLIM_NPM_DIGEST ?? npmDigest;
    const extra: NodeJS.ProcessEnv = {};
    if (digest) extra.SLIM_NPM_DIGEST = digest;
    const out = await runSlim(slimJs, ["upstream", "--json"], dest, extra, 120_000);
    const combined = `${out.stdout}\n${out.stderr}`;
    assert.ok(out.stdout.trim().startsWith("{"), combined);
    const doc = JSON.parse(out.stdout.trim()) as {
      conclusion: string;
      action: string;
      exit: number;
      findings: unknown[];
      sources?: { osv: { status: string; detail: string }; npm: { status: string; detail: string } };
    };
    assert.ok(doc.sources, combined);
    assert.equal(doc.sources.osv.status, "success", doc.sources.osv.detail);
    assert.equal(doc.sources.npm.status, "success", doc.sources.npm.detail);
    assert.notEqual(doc.conclusion, "source-unavailable");
    if (doc.conclusion === "not-exposed") {
      assert.equal(doc.findings.length, 0);
    } else {
      assert.equal(/slice not exposed/i.test(combined), false);
      assert.ok(
        ["exposed", "unmapped", "routine-release"].includes(doc.conclusion),
        `unexpected conclusion ${doc.conclusion}`,
      );
    }
    const receiptsDir = process.env.SLIM_RECEIPTS_DIR;
    if (receiptsDir) {
      const commit =
        process.env.SLIM_CANDIDATE_COMMIT ??
        execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
      const log = `${doc.conclusion}:${doc.sources.osv.status}:${doc.sources.npm.status}:${out.status}`;
      for (const service of ["osv", "npm-registry"] as const) {
        writeReceipt(
          receiptsDir,
          `externalService.${service}`,
          sourceReceipt({
            service,
            fixture: FIXTURE,
            commit,
            npmDigest: digest,
            startedAt,
            endedAt: new Date(),
            log,
            workflowRun: process.env.SLIM_WORKFLOW_RUN ?? null,
          }),
        );
      }
    }
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
});
