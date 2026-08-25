import { SlimExit, EXIT_ENV, EXIT_FAIL } from "../exit.ts";
import { buildPrompt } from "./prompt.ts";
import { withGeneratedHeader } from "./header.ts";
import type { Envelope } from "../envelope/types.ts";
import type { PublicApiSpec } from "./public-api.ts";

export interface LlmConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  kind: "anthropic" | "openai";
}

const FETCH_MS = 60_000;
const MAX_TOKENS = 8192;

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
  publicApi: PublicApiSpec,
  counterexamples: string[],
  cfg: LlmConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<{ source: string; promptHash: string }> {
  const { system, user, promptHash } = buildPrompt(envelope, publicApi, counterexamples);
  const text = cfg.kind === "anthropic"
    ? await completeAnthropic(cfg, system, user, fetchImpl)
    : await completeOpenAi(cfg, system, user, fetchImpl);
  const body = stripFences(text);
  if (!hasExportDeclaration(body)) {
    throw failClosed(cfg, EXIT_FAIL, "LLM returned no TypeScript exports");
  }
  const source = withGeneratedHeader(body, envelope, { promptHash });
  return { source, promptHash };
}

async function completeAnthropic(
  cfg: LlmConfig,
  system: string,
  user: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const json = await postJson(cfg, fetchImpl, {
    "content-type": "application/json",
    "x-api-key": cfg.apiKey,
    "anthropic-version": "2023-06-01",
  }, {
    model: cfg.model,
    max_tokens: MAX_TOKENS,
    temperature: 0,
    system,
    messages: [{ role: "user", content: user }],
  }) as { content?: Array<{ text?: string }> };
  return json.content?.map((c) => c.text ?? "").join("\n") ?? "";
}

async function completeOpenAi(
  cfg: LlmConfig,
  system: string,
  user: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const json = await postJson(cfg, fetchImpl, {
    "content-type": "application/json",
    authorization: `Bearer ${cfg.apiKey}`,
  }, {
    model: cfg.model,
    temperature: 0,
    max_tokens: MAX_TOKENS,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  }) as { choices?: Array<{ message?: { content?: string } }> };
  return json.choices?.[0]?.message?.content ?? "";
}

async function postJson(
  cfg: LlmConfig,
  fetchImpl: typeof fetch,
  headers: Record<string, string>,
  body: unknown,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(cfg.baseUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_MS),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw failClosed(cfg, EXIT_ENV, `LLM network error: ${msg}`);
  }
  const raw = await res.text();
  if (!res.ok) {
    throw failClosed(cfg, EXIT_ENV, `LLM HTTP ${res.status}: ${raw.slice(0, 400)}`);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw failClosed(cfg, EXIT_FAIL, `LLM returned invalid JSON: ${raw.slice(0, 400)}`);
  }
}

function hasExportDeclaration(src: string): boolean {
  return /^export\s/m.test(src);
}

function stripFences(s: string): string {
  const m = s.match(/```(?:ts|typescript|js)?\n([\s\S]*?)```/);
  return (m?.[1] ?? s).trim() + "\n";
}

function failClosed(cfg: LlmConfig, code: number, message: string): SlimExit {
  return new SlimExit(code, redact(message, cfg.apiKey));
}

function redact(text: string, key: string): string {
  if (!key) return text;
  return text.split(key).join("[REDACTED]");
}
