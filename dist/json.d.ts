export declare const JSON_SCHEMA_VERSION: 1;
export type CliStatus = "ok" | "fail" | "usage" | "refused" | "env";
export declare function statusFromExit(code: number): CliStatus;
export declare function writeJson(value: unknown): void;
export declare function writeErrorJson(exit: number, error: string): void;
export declare function errorDocument(exit: number, error: string): {
    schemaVersion: typeof JSON_SCHEMA_VERSION;
    ok: false;
    exit: number;
    status: CliStatus;
    error: string;
};
