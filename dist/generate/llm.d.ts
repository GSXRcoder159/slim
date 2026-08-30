import type { Envelope } from "../envelope/types.ts";
import type { PublicApiSpec } from "./public-api.ts";
export interface LlmConfig {
    baseUrl: string;
    model: string;
    apiKey: string;
    kind: "anthropic" | "openai";
}
export declare function llmConfigFromEnv(env?: NodeJS.ProcessEnv): LlmConfig | null;
export declare function generateWithLlm(envelope: Envelope, publicApi: PublicApiSpec, counterexamples: string[], cfg: LlmConfig, fetchImpl?: typeof fetch): Promise<{
    source: string;
    promptHash: string;
}>;
