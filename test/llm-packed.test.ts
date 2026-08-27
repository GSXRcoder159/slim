import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addModuleSource,
  installFixture,
  packSlim,
  protoMutationSource,
  readJson,
  replaceLlmArgs,
  runSlim,
  startLlmMock,
  writeTinyAddFixture,
} from "./helpers/llm-replace.ts";

let packDir = "";
let tarball = "";

before(() => {
  const packed = packSlim();
  packDir = packed.packDir;
  tarball = packed.tarball;
});

after(() => {
  if (packDir) rmSync(packDir, { recursive: true, force: true });
});

function assertCleanRoomBody(body: string): void {
  assert.doesNotMatch(body, /FROM_IMPL/);
  assert.doesNotMatch(body, /SENTINEL_PUBLIC_SPEC_ESCAPE/);
  assert.doesNotMatch(body, /node_modules\/[^"'\\\s]+\.js/);
  assert.doesNotMatch(body, /padpadpad/);
}

test("packed replace --llm via mocked Anthropic completes the pipeline", { timeout: 180_000 }, async () => {
  const dest = mkdtempSync(join(tmpdir(), "slim-llm-anth-"));
  const mock = await startLlmMock("anthropic", addModuleSource());
  try {
    writeTinyAddFixture(dest);
    const slimJs = installFixture(dest, tarball);
    const out = await runSlim(slimJs, replaceLlmArgs(), dest, {
      ANTHROPIC_API_KEY: "sk-test-anthropic",
      SLIM_LLM_BASE_URL: `http://127.0.0.1:${mock.port}/`,
      SLIM_LLM_MODEL: "claude-sonnet-4-5",
    });
    assert.equal(out.status, 0, `${out.stdout}\n${out.stderr}`);
    assert.ok(mock.requests.length >= 1, "Anthropic mock received no request");
    assert.equal(mock.headerSnapshots[0]?.["x-api-key"], "sk-test-anthropic");
    assert.equal(mock.headerSnapshots[0]?.["anthropic-version"], "2023-06-01");
    const body = JSON.parse(mock.requests[0]!) as { max_tokens?: number };
    assert.equal(body.max_tokens, 8192);
    assertCleanRoomBody(mock.requests[0]!);

    const slice = join(dest, "src/slim/tiny-add.ts");
    assert.ok(existsSync(slice));
    assert.match(readFileSync(slice, "utf8"), /export function add/);
    assert.ok(existsSync(join(dest, "src/slim/tiny-add.test.ts")));
    const pkg = readJson(join(dest, "package.json")) as { dependencies?: Record<string, string> };
    assert.equal(pkg.dependencies?.["tiny-add"], undefined);
    const checked = await runSlim(slimJs, ["check"], dest);
    assert.equal(checked.status, 0, `${checked.stdout}\n${checked.stderr}`);
    const evidence = readJson(join(dest, ".slim/tiny-add/evidence.json")) as {
      generation?: { kind?: string; provider?: string; model?: string; promptHash?: string };
    };
    assert.equal(evidence.generation?.kind, "llm");
    assert.equal(evidence.generation?.provider, "anthropic");
    assert.equal(evidence.generation?.model, "claude-sonnet-4-5");
    assert.ok(evidence.generation?.promptHash);
    const evidenceRaw = readFileSync(join(dest, ".slim/tiny-add/evidence.json"), "utf8");
    assert.doesNotMatch(evidenceRaw, /sk-test-anthropic/);
  } finally {
    await mock.close();
    rmSync(dest, { recursive: true, force: true });
  }
});

test("packed replace --llm via mocked OpenAI completes the pipeline", { timeout: 180_000 }, async () => {
  const dest = mkdtempSync(join(tmpdir(), "slim-llm-oai-"));
  const mock = await startLlmMock("openai", addModuleSource());
  try {
    writeTinyAddFixture(dest);
    const slimJs = installFixture(dest, tarball);
    const out = await runSlim(slimJs, replaceLlmArgs(), dest, {
      OPENAI_API_KEY: "sk-test-openai",
      SLIM_LLM_BASE_URL: `http://127.0.0.1:${mock.port}/`,
      SLIM_LLM_MODEL: "gpt-4.1",
    });
    assert.equal(out.status, 0, `${out.stdout}\n${out.stderr}`);
    assert.ok(mock.requests.length >= 1);
    assert.match(String(mock.headerSnapshots[0]?.authorization), /Bearer sk-test-openai/);
    assertCleanRoomBody(mock.requests[0]!);
    const evidence = readJson(join(dest, ".slim/tiny-add/evidence.json")) as {
      generation?: { kind?: string; provider?: string; model?: string };
    };
    assert.equal(evidence.generation?.kind, "llm");
    assert.equal(evidence.generation?.provider, "openai");
    assert.equal(evidence.generation?.model, "gpt-4.1");
    const pkg = readJson(join(dest, "package.json")) as { dependencies?: Record<string, string> };
    assert.equal(pkg.dependencies?.["tiny-add"], undefined);
  } finally {
    await mock.close();
    rmSync(dest, { recursive: true, force: true });
  }
});

test("packed replace --llm refuses escaping types before any provider call", { timeout: 180_000 }, async () => {
  const dest = mkdtempSync(join(tmpdir(), "slim-llm-esc-"));
  const mock = await startLlmMock("anthropic", addModuleSource());
  try {
    writeTinyAddFixture(dest, { escapingTypes: true });
    const slimJs = installFixture(dest, tarball);
    const before = readFileSync(join(dest, "package.json"), "utf8");
    const beforeSrc = readFileSync(join(dest, "src/index.ts"), "utf8");
    const out = await runSlim(slimJs, replaceLlmArgs(), dest, {
      ANTHROPIC_API_KEY: "sk-test-anthropic",
      SLIM_LLM_BASE_URL: `http://127.0.0.1:${mock.port}/`,
    });
    assert.notEqual(out.status, 0, `${out.stdout}\n${out.stderr}`);
    assert.match(`${out.stdout}\n${out.stderr}`, /public spec escapes/i);
    assert.equal(mock.requests.length, 0, "provider must not be called on spec escape");
    assert.equal(existsSync(join(dest, "src/slim")), false);
    assert.equal(readFileSync(join(dest, "package.json"), "utf8"), before);
    assert.equal(readFileSync(join(dest, "src/index.ts"), "utf8"), beforeSrc);
  } finally {
    await mock.close();
    rmSync(dest, { recursive: true, force: true });
  }
});

test("packed replace --llm rejects prototype-mutation before project writes", { timeout: 180_000 }, async () => {
  const dest = mkdtempSync(join(tmpdir(), "slim-llm-proto-"));
  const mock = await startLlmMock("anthropic", protoMutationSource());
  try {
    writeTinyAddFixture(dest);
    const slimJs = installFixture(dest, tarball);
    const before = readFileSync(join(dest, "package.json"), "utf8");
    const out = await runSlim(slimJs, replaceLlmArgs(), dest, {
      ANTHROPIC_API_KEY: "sk-test-anthropic",
      SLIM_LLM_BASE_URL: `http://127.0.0.1:${mock.port}/`,
    });
    assert.notEqual(out.status, 0, `${out.stdout}\n${out.stderr}`);
    assert.match(`${out.stdout}\n${out.stderr}`, /prototype-mutation|AST allowlist/);
    assert.ok(mock.requests.length >= 1);
    assert.equal(existsSync(join(dest, "src/slim")), false);
    assert.equal(readFileSync(join(dest, "package.json"), "utf8"), before);
  } finally {
    await mock.close();
    rmSync(dest, { recursive: true, force: true });
  }
});
