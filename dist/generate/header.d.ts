import { type Envelope } from "../envelope/types.ts";
export declare function generatedHeader(env: Envelope, opts?: {
    catalogIds?: string[];
    promptHash?: string;
}): string;
/** Prepend the Slim header. Strips an existing leading block comment so it is idempotent. */
export declare function withGeneratedHeader(source: string, env: Envelope, opts?: {
    catalogIds?: string[];
    promptHash?: string;
}): string;
