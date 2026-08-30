import type { Envelope } from "./types.ts";
export declare function closeEnvelope(env: Envelope, opts?: {
    allowUnknown?: boolean;
    staticOnly?: boolean;
}): Envelope;
