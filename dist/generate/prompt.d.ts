import type { Envelope } from "../envelope/types.ts";
import type { PublicApiSpec } from "./public-api.ts";
export declare function capCounterexamples(examples: string[]): string[];
export declare function buildPrompt(env: Envelope, publicApi: PublicApiSpec, counterexamples: string[]): {
    system: string;
    user: string;
    promptHash: string;
};
