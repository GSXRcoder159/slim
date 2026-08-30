import type { CallSite, Envelope } from "./types.ts";
export interface EnvelopeDrift {
    kind: string;
    detail: string;
}
export declare function callSiteFingerprint(site: CallSite): string;
export declare function diffEnvelope(saved: Envelope, live: Envelope): EnvelopeDrift[];
