import { test } from "node:test";
import assert from "node:assert/strict";
import { llmConfigFromEnv, generateWithLlm } from "../src/generate/llm.ts";
import { ENVELOPE_VERSION, emptyHyrum } from "../src/envelope/types.ts";
import type { Envelope } from "../src/envelope/types.ts";

test("llmConfigFromEnv reads Anthropic", () => {
  const c = llmConfigFromEnv({
    ANTHROPIC_API_KEY: "sk-test",
    SLIM_LLM_MODEL: "claude-test",
  } as NodeJS.ProcessEnv);
  assert.ok(c);
  assert.equal(c!.kind, "anthropic");
  assert.equal(c!.model, "claude-test");
});

test("generateWithLlm uses a fake provider", async () => {
  const env: Envelope = {
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
  const fake: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        content: [{ text: "```ts\nexport function ms(x: unknown) { return 1; }\nexport default { ms };\n```" }],
      }),
      { status: 200 },
    );
  const out = await generateWithLlm(
    env,
    "export function ms(val: string | number): number;",
    [],
    {
      baseUrl: "https://api.anthropic.com/v1/messages",
      model: "x",
      apiKey: "k",
      kind: "anthropic",
    },
    fake,
  );
  assert.match(out.source, /export function ms/);
  assert.ok(out.promptHash);
  assert.match(out.source, /SPDX-License-Identifier: MIT/);
  assert.match(out.source, new RegExp(`Prompt ${out.promptHash}`));
  assert.match(out.source, /Differential fuzzing is evidence, not proof/);
});
