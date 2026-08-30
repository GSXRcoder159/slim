export declare const FETCH_MS = 15000;
export type SourceStatus = "success" | "unavailable" | "timeout" | "malformed" | "stale";
export interface SourceResult<T> {
    status: SourceStatus;
    value?: T;
    detail: string;
}
export declare function sourceOk<T>(value: T, detail?: string): SourceResult<T>;
export declare function sourceErr<T>(status: Exclude<SourceStatus, "success">, detail: string): SourceResult<T>;
export declare function sourceNotRequired<T>(): SourceResult<T>;
export declare function isConsultedFailure(s: {
    status: SourceStatus;
    detail: string;
}): boolean;
export declare function cmpVersion(a: string, b: string): number;
export declare function fetchJson(url: string, init?: RequestInit, fetchImpl?: typeof fetch): Promise<SourceResult<unknown>>;
