import { test } from "node:test";
import assert from "node:assert/strict";
import { generateWithLlm, llmConfigFromEnv } from "../src/generate/llm.ts";
import { assertValidGenerated } from "../src/generate/validate.ts";
import { checkContracts } from "../src/generate/exports.ts";
import { ENVELOPE_VERSION, emptyHyrum } from "../src/envelope/types.ts";
import type { Envelope } from "../src/envelope/types.ts";
import * as ts from "typescript";

const live = process.env.SLIM_LLM_LIVE === "1";

function env(): Envelope {
  return {
    schemaVersion: ENVELOPE_VERSION,
    package: { name: "ms", version: "2", family: "ms", subpath: "" },
    env: ["node"],
    imports: [],
    symbols: [
      {
        exportName: "default",
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

const spec = {
  text: "export default function ms(value: string | number): number;",
  source: "bundled-dts" as const,
};

if (live && process.env.ANTHROPIC_API_KEY) {
  test("live Anthropic smoke produces a valid module", async () => {
    const cfg = llmConfigFromEnv({
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    } as NodeJS.ProcessEnv);
    assert.ok(cfg);
    const out = await generateWithLlm(env(), spec, [], cfg!);
    assert.ok(out.promptHash);
    assert.match(out.source, /SPDX-License-Identifier: MIT/);
    assert.doesNotMatch(out.source, /FROM_IMPL/);
    assertValidGenerated(ts, out.source, env());
    const contracts = checkContracts(ts, out.source, env());
    assert.equal(contracts.ok, true, contracts.errors.join("; "));
  });
}

if (live && process.env.OPENAI_API_KEY) {
  test("live OpenAI smoke produces a valid module", async () => {
    const cfg = llmConfigFromEnv({
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    } as NodeJS.ProcessEnv);
    assert.ok(cfg);
    const out = await generateWithLlm(env(), spec, [], cfg!);
    assert.ok(out.promptHash);
    assert.match(out.source, /SPDX-License-Identifier: MIT/);
    assert.doesNotMatch(out.source, /FROM_IMPL/);
    assertValidGenerated(ts, out.source, env());
    const contracts = checkContracts(ts, out.source, env());
    assert.equal(contracts.ok, true, contracts.errors.join("; "));
  });
}
