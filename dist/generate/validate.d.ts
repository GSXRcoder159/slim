import type { Envelope } from "../envelope/types.ts";
export interface ValidateOptions {
    fileName?: string;
    envelope?: Envelope;
}
export interface ValidateResult {
    ok: boolean;
    errors: string[];
}
export declare function validateGenerated(ts: typeof import("typescript"), source: string, fileNameOrOpts?: string | ValidateOptions): ValidateResult;
export declare function assertValidGenerated(ts: typeof import("typescript"), source: string, envelope?: Envelope): void;
export declare function assertSmaller(replacementBytes: number, originalBytes: number, force: boolean): void;
