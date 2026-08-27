import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalInventory } from "../src/support/inventory.ts";
import { providerReceipt, writeReceipt } from "../src/support/receipts.ts";
import {
  installFixture,
  packSlim,
  replaceLlmArgs,
  runSlim,
  writeTinyAddFixture,
} from "./helpers/llm-replace.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadDotEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq);
    if (process.env[name]) continue;
    let value = trimmed.slice(eq + 1);
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[name] = value;
  }
}

if (process.env.SLIM_LLM_LIVE === "1") loadDotEnv(join(ROOT, ".env"));
const LIVE = process.env.SLIM_LLM_LIVE === "1";

let packDir = "";
let tarball = "";

before(() => {
  if (!LIVE) return;
  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) return;
  const packed = packSlim();
  packDir = packed.packDir;
  tarball = packed.tarball;
});

after(() => {
  if (packDir) rmSync(packDir, { recursive: true, force: true });
});

test("support inventory advertises anthropic and openai as required live providers", () => {
  const providers = canonicalInventory().entries.filter((e) => e.kind === "provider");
  assert.deepEqual(
    providers.map((p) => p.name).sort(),
    ["anthropic", "openai"],
  );
  for (const p of providers) {
    assert.equal(p.receiptClass, "live");
    assert.equal(p.checkId, "test/llm-live.test.ts");
  }
});

for (const name of ["openai", "anthropic"] as const) {
  test(`live packed replace --llm via ${name}`, { timeout: 300_000 }, async () => {
    if (!LIVE) {
      assert.equal(process.env.SLIM_LLM_LIVE ?? "", "", "live tests stay registered when SLIM_LLM_LIVE is unset");
      return;
    }
    const keyName = name === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
    const key = process.env[keyName];
    assert.ok(key, `${keyName} is required when SLIM_LLM_LIVE=1`);
    const dest = mkdtempSync(join(tmpdir(), `slim-llm-live-${name}-`));
    const startedAt = new Date();
    try {
      writeTinyAddFixture(dest);
      const slimJs = installFixture(dest, tarball);
      const model = name === "anthropic" ? "claude-sonnet-4-5" : "gpt-5.6-sol";
      const extra: NodeJS.ProcessEnv = { SLIM_LLM_MODEL: model };
      extra[keyName] = key;
      const out = await runSlim(slimJs, replaceLlmArgs(), dest, extra, 240_000);
      assert.equal(out.status, 0, `${out.stdout}\n${out.stderr}`);
      const evidencePath = join(dest, ".slim/tiny-add/evidence.json");
      assert.ok(existsSync(evidencePath));
      const evidenceRaw = readFileSync(evidencePath, "utf8");
      assert.doesNotMatch(evidenceRaw, /ANTHROPIC_API_KEY|OPENAI_API_KEY|sk-/);
      const evidence = JSON.parse(evidenceRaw) as {
        envelopeHash?: string;
        generation?: { kind?: string; provider?: string; model?: string; promptHash?: string };
      };
      assert.equal(evidence.generation?.kind, "llm");
      assert.equal(evidence.generation?.provider, name);
      const receiptsDir = process.env.SLIM_RECEIPTS_DIR;
      if (receiptsDir) {
        const commit =
          process.env.SLIM_CANDIDATE_COMMIT ??
          execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
        writeReceipt(
          receiptsDir,
          `provider.${name}`,
          providerReceipt({
            provider: name,
            model: evidence.generation?.model ?? model,
            fixture: "tiny-add",
            commit,
            npmDigest: process.env.SLIM_NPM_DIGEST ?? null,
            startedAt,
            endedAt: new Date(),
            log: `${evidence.envelopeHash ?? ""}:${evidence.generation?.promptHash ?? ""}:${out.status}`,
            workflowRun: process.env.SLIM_WORKFLOW_RUN ?? null,
          }),
        );
      }
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });
}
