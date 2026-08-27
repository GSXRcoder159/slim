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

const FETCH_MS = 120_000;
const MAX_TOKENS = 8192;

export function llmConfigFromEnv(env = process.env): LlmConfig | null {
  const anthropic = env.ANTHROPIC_API_KEY;
  const openai = env.OPENAI_API_KEY;
  const hinted = env.SLIM_LLM_BASE_URL ?? "";
  const kind: "anthropic" | "openai" = hinted.includes("anthropic")
    ? "anthropic"
    : openai || hinted.includes("openai")
      ? "openai"
      : anthropic
        ? "anthropic"
        : "openai";
  const apiKey = (kind === "anthropic" ? anthropic : openai) || env.SLIM_LLM_API_KEY || "";
  const base =
    env.SLIM_LLM_BASE_URL ||
    (kind === "anthropic"
      ? "https://api.anthropic.com/v1/messages"
      : "https://api.openai.com/v1/responses");
  const model =
    env.SLIM_LLM_MODEL || (kind === "anthropic" ? "claude-sonnet-4-5" : "gpt-5.6-sol");
  if (!apiKey || !base || !model) return null;
  return { baseUrl: base, model, apiKey, kind };
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
    instructions: system,
    input: user,
    max_output_tokens: MAX_TOKENS,
    store: false,
  });
  return openAiOutputText(json);
}

function openAiOutputText(json: unknown): string {
  if (!json || typeof json !== "object") return "";
  const rec = json as Record<string, unknown>;
  if (typeof rec.output_text === "string" && rec.output_text.trim()) return rec.output_text;
  if (!Array.isArray(rec.output)) return "";
  const parts: string[] = [];
  for (const item of rec.output) {
    if (!item || typeof item !== "object") continue;
    const entry = item as { type?: string; content?: unknown };
    if (entry.type !== "message" || !Array.isArray(entry.content)) continue;
    for (const part of entry.content) {
      if (!part || typeof part !== "object") continue;
      const content = part as { type?: string; text?: string };
      if (content.type === "output_text" && typeof content.text === "string") parts.push(content.text);
    }
  }
  return parts.join("\n");
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
