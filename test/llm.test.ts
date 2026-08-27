import { test } from "node:test";
import assert from "node:assert/strict";
import { llmConfigFromEnv, generateWithLlm, type LlmConfig } from "../src/generate/llm.ts";
import { SlimExit, EXIT_ENV, EXIT_FAIL } from "../src/exit.ts";
import { ENVELOPE_VERSION, emptyHyrum } from "../src/envelope/types.ts";
import type { Envelope } from "../src/envelope/types.ts";
import type { PublicApiSpec } from "../src/generate/public-api.ts";

const spec: PublicApiSpec = {
  text: "export function ms(val: string | number): number;",
  source: "bundled-dts",
  from: "node_modules/ms/index.d.ts",
};

function env(): Envelope {
  return {
    schemaVersion: ENVELOPE_VERSION,
    package: { name: "ms", version: "2", family: "ms", subpath: "" },
    env: ["node"],
    imports: [],
    symbols: [
      {
        exportName: "ms",
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

const anthropic: LlmConfig = {
  baseUrl: "https://api.anthropic.com/v1/messages",
  model: "x",
  apiKey: "sk-secret-key-xyz",
  kind: "anthropic",
};

const openai: LlmConfig = {
  baseUrl: "https://api.openai.com/v1/responses",
  model: "gpt-5.6-sol",
  apiKey: "sk-secret-key-xyz",
  kind: "openai",
};

function assertSlimExit(err: unknown, code: number): SlimExit {
  assert.ok(err instanceof SlimExit);
  assert.equal(err.code, code);
  assert.doesNotMatch(err.message, /sk-secret-key-xyz/);
  return err;
}

function assertCleanRoomBody(init: RequestInit): void {
  const raw = String(init.body);
  assert.doesNotMatch(raw, /FROM_IMPL/);
  assert.doesNotMatch(raw, /node_modules\/[^"'\\\s]+\.js/);
  assert.doesNotMatch(raw, /index\.js/);
}

const providers: LlmConfig[] = [anthropic, openai];

test("llmConfigFromEnv reads Anthropic", () => {
  const c = llmConfigFromEnv({
    ANTHROPIC_API_KEY: "sk-test",
    SLIM_LLM_MODEL: "claude-test",
  } as NodeJS.ProcessEnv);
  assert.ok(c);
  assert.equal(c!.kind, "anthropic");
  assert.equal(c!.model, "claude-test");
});

test("llmConfigFromEnv reads OpenAI", () => {
  const c = llmConfigFromEnv({
    OPENAI_API_KEY: "sk-openai",
  } as NodeJS.ProcessEnv);
  assert.ok(c);
  assert.equal(c!.kind, "openai");
  assert.equal(c!.model, "gpt-5.6-sol");
  assert.equal(c!.baseUrl, "https://api.openai.com/v1/responses");
});

test("llmConfigFromEnv prefers OpenAI when both keys are set", () => {
  const c = llmConfigFromEnv({
    ANTHROPIC_API_KEY: "sk-anthropic",
    OPENAI_API_KEY: "sk-openai",
  } as NodeJS.ProcessEnv);
  assert.ok(c);
  assert.equal(c!.kind, "openai");
  assert.equal(c!.apiKey, "sk-openai");
  assert.equal(c!.model, "gpt-5.6-sol");
});

test("llmConfigFromEnv uses Anthropic when OpenAI is unset", () => {
  const c = llmConfigFromEnv({
    ANTHROPIC_API_KEY: "sk-anthropic",
  } as NodeJS.ProcessEnv);
  assert.ok(c);
  assert.equal(c!.kind, "anthropic");
  assert.equal(c!.apiKey, "sk-anthropic");
  assert.equal(c!.baseUrl, "https://api.anthropic.com/v1/messages");
});

test("llmConfigFromEnv uses Anthropic when the base URL is Anthropic", () => {
  const c = llmConfigFromEnv({
    ANTHROPIC_API_KEY: "sk-anthropic",
    OPENAI_API_KEY: "sk-openai",
    SLIM_LLM_BASE_URL: "https://api.anthropic.com/v1/messages",
  } as NodeJS.ProcessEnv);
  assert.ok(c);
  assert.equal(c!.kind, "anthropic");
  assert.equal(c!.apiKey, "sk-anthropic");
});

test("llmConfigFromEnv returns null without a key", () => {
  assert.equal(llmConfigFromEnv({} as NodeJS.ProcessEnv), null);
  assert.equal(
    llmConfigFromEnv({
      ANTHROPIC_API_KEY: "",
      OPENAI_API_KEY: "",
      SLIM_LLM_API_KEY: "",
    } as NodeJS.ProcessEnv),
    null,
  );
  assert.equal(
    llmConfigFromEnv({
      SLIM_LLM_BASE_URL: "https://api.openai.com/v1/responses",
      SLIM_LLM_MODEL: "gpt-5.6-sol",
    } as NodeJS.ProcessEnv),
    null,
  );
});

test("generateWithLlm uses a fake provider", async () => {
  const fake: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        content: [{ text: "```ts\nexport function ms(x: unknown) { return 1; }\nexport default { ms };\n```" }],
      }),
      { status: 200 },
    );
  const out = await generateWithLlm(env(), spec, [], anthropic, fake);
  assert.match(out.source, /export function ms/);
  assert.ok(out.promptHash);
  assert.match(out.source, /SPDX-License-Identifier: MIT/);
  assert.match(out.source, new RegExp(`Prompt ${out.promptHash}`));
  assert.match(out.source, /Differential fuzzing is evidence, not proof/);
});

test("Anthropic request contract", async () => {
  let url = "";
  let init: RequestInit = {};
  const fake: typeof fetch = async (input, i) => {
    url = String(input);
    init = i ?? {};
    return new Response(
      JSON.stringify({ content: [{ text: "export function ms() { return 1; }\n" }] }),
      { status: 200 },
    );
  };
  await generateWithLlm(env(), spec, [], anthropic, fake);
  assert.equal(url, anthropic.baseUrl);
  const headers = new Headers(init.headers);
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("x-api-key"), anthropic.apiKey);
  assert.equal(headers.get("anthropic-version"), "2023-06-01");
  assert.ok(init.signal);
  const body = JSON.parse(String(init.body)) as {
    model: string;
    max_tokens: number;
    temperature: number;
    system: string;
    messages: Array<{ role: string }>;
  };
  assert.equal(body.model, "x");
  assert.equal(body.max_tokens, 8192);
  assert.equal(body.temperature, 0);
  assert.ok(body.system);
  assert.equal(body.messages[0]?.role, "user");
  assertCleanRoomBody(init);
  assert.match(String(init.body), /index\.d\.ts/);
});

test("OpenAI request contract", async () => {
  let init: RequestInit = {};
  const fake: typeof fetch = async (_input, i) => {
    init = i ?? {};
    return new Response(
      JSON.stringify({
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "export function ms() { return 1; }\n" }],
          },
        ],
      }),
      { status: 200 },
    );
  };
  const out = await generateWithLlm(env(), spec, [], openai, fake);
  assert.match(out.source, /export function ms/);
  const headers = new Headers(init.headers);
  assert.equal(headers.get("authorization"), "Bearer sk-secret-key-xyz");
  assert.ok(init.signal);
  const body = JSON.parse(String(init.body)) as {
    model: string;
    instructions?: string;
    input?: unknown;
    max_output_tokens?: number;
    store?: boolean;
    messages?: unknown;
    max_tokens?: number;
    temperature?: number;
  };
  assert.equal(body.model, "gpt-5.6-sol");
  assert.equal(body.max_output_tokens, 8192);
  assert.equal(body.store, false);
  assert.ok(body.instructions);
  assert.equal(typeof body.input, "string");
  assert.equal(body.messages, undefined);
  assert.equal(body.max_tokens, undefined);
  assert.equal(body.temperature, undefined);
  assertCleanRoomBody(init);
  assert.match(String(init.body), /index\.d\.ts/);
});

test("HTTP 429 and 5xx are EXIT_ENV for both providers and redact the key", async () => {
  for (const cfg of providers) {
    for (const status of [429, 500, 502, 503]) {
      const fake: typeof fetch = async () =>
        new Response(`unauthorized sk-secret-key-xyz`, { status });
      await assert.rejects(
        () => generateWithLlm(env(), spec, [], cfg, fake),
        (err: unknown) => {
          const e = assertSlimExit(err, EXIT_ENV);
          assert.match(e.message, new RegExp(`LLM HTTP ${status}`));
          return true;
        },
      );
    }
  }
});

test("AbortError and TimeoutError are EXIT_ENV for both providers", async () => {
  const errors = [
    new DOMException("The operation was aborted", "AbortError"),
    new DOMException("The operation was aborted due to timeout", "TimeoutError"),
  ];
  for (const cfg of providers) {
    for (const thrown of errors) {
      const fake: typeof fetch = async () => {
        throw thrown;
      };
      await assert.rejects(
        () => generateWithLlm(env(), spec, [], cfg, fake),
        (err: unknown) => {
          const e = assertSlimExit(err, EXIT_ENV);
          assert.match(e.message, /LLM network error/);
          return true;
        },
      );
    }
  }
});

test("fetch throw is EXIT_ENV", async () => {
  const fake: typeof fetch = async () => {
    throw new Error("ECONNRESET sk-secret-key-xyz");
  };
  await assert.rejects(
    () => generateWithLlm(env(), spec, [], openai, fake),
    (err: unknown) => {
      assertSlimExit(err, EXIT_ENV);
      return true;
    },
  );
});

test("malformed JSON is EXIT_FAIL for both providers", async () => {
  for (const cfg of providers) {
    const fake: typeof fetch = async () => new Response("not-json sk-secret-key-xyz", { status: 200 });
    await assert.rejects(
      () => generateWithLlm(env(), spec, [], cfg, fake),
      (err: unknown) => {
        const e = assertSlimExit(err, EXIT_FAIL);
        assert.match(e.message, /invalid JSON/);
        return true;
      },
    );
  }
});

test("empty and prose-only responses are EXIT_FAIL", async () => {
  const empty: typeof fetch = async () =>
    new Response(JSON.stringify({ content: [] }), { status: 200 });
  const prose: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "Sure, here is some advice. You should export a function." }],
          },
        ],
      }),
      { status: 200 },
    );
  await assert.rejects(
    () => generateWithLlm(env(), spec, [], anthropic, empty),
    (err: unknown) => {
      assertSlimExit(err, EXIT_FAIL);
      return true;
    },
  );
  await assert.rejects(
    () => generateWithLlm(env(), spec, [], openai, prose),
    (err: unknown) => {
      assertSlimExit(err, EXIT_FAIL);
      return true;
    },
  );
});
