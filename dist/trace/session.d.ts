export declare const TRACE_SESSION_V: 1;
export type TraceSessionLine = {
    t: "session";
    hook: true;
    v: typeof TRACE_SESSION_V;
};
export type TraceErrorKind = "serialize" | "unresolved-star" | "worker";
export type TraceErrorRecord = {
    t: "error";
    kind: TraceErrorKind | string;
    message?: string;
};
export declare function sessionRecord(): TraceSessionLine;
export declare function sessionLine(): string;
export declare function errorRecord(kind: string, message?: string): TraceErrorRecord;
export declare function errorLine(kind: string, message?: string): string;
export declare function isSessionRecord(v: unknown): v is TraceSessionLine;
export declare function isErrorRecord(v: unknown): v is TraceErrorRecord;
