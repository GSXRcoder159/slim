import type { Envelope } from "../envelope/types.ts";
export interface ContractResult {
    ok: boolean;
    errors: string[];
}
export declare function checkContracts(ts: typeof import("typescript"), source: string, envelope: Envelope): ContractResult;
