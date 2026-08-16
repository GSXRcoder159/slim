import { SlimExit, EXIT_REFUSED } from "../exit.ts";
import { buildPrompt } from "./prompt.ts";
import type { Envelope } from "../envelope/types.ts";

export interface LlmConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  kind: "anthropic" | "openai";
}

export function llmConfigFromEnv(env = process.env): LlmConfig | null {
  const anthropic = env.ANTHROPIC_API_KEY;
  const openai = env.OPENAI_API_KEY;
  const base =
    env.SLIM_LLM_BASE_URL ||
    (anthropic
      ? "https://api.anthropic.com/v1/messages"
      : openai
        ? "https://api.openai.com/v1/chat/completions"
        : "");
  const model =
    env.SLIM_LLM_MODEL ||
    (anthropic ? "claude-sonnet-4-5" : openai ? "gpt-4.1" : "");
  const apiKey = anthropic || openai || env.SLIM_LLM_API_KEY || "";
  if (!apiKey || !base || !model) return null;
  return {
    baseUrl: base,
    model,
    apiKey,
    kind: anthropic || base.includes("anthropic") ? "anthropic" : "openai",
  };
}

export async function generateWithLlm(
  envelope: Envelope,
  publicApi: string,
  counterexamples: string[],
  cfg: LlmConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<{ source: string; promptHash: string }> {
  const { system, user, promptHash } = buildPrompt(envelope, publicApi, counterexamples);
  let text: string;
  if (cfg.kind === "anthropic") {
    const res = await fetchImpl(cfg.baseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": cfg.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: 8192,
        temperature: 0,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });
    if (!res.ok) {
      throw new SlimExit(EXIT_REFUSED, `LLM HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
    }
    const json = (await res.json()) as { content?: Array<{ text?: string }> };
    text = json.content?.map((c) => c.text ?? "").join("\n") ?? "";
  } else {
    const res = await fetchImpl(cfg.baseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) {
      throw new SlimExit(EXIT_REFUSED, `LLM HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    text = json.choices?.[0]?.message?.content ?? "";
  }
  const source = stripFences(text);
  if (!source.includes("export")) {
    throw new SlimExit(EXIT_REFUSED, "LLM returned no TypeScript exports");
  }
  return { source, promptHash };
}

function stripFences(s: string): string {
  const m = s.match(/```(?:ts|typescript|js)?\n([\s\S]*?)```/);
  return (m?.[1] ?? s).trim() + "\n";
}
