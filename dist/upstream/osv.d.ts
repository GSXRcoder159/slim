import { type SourceResult } from "./status.ts";
export interface OsvRange {
    type?: string;
    events?: Array<{
        introduced?: string;
        fixed?: string;
        last_affected?: string;
    }>;
}
export interface OsvAffected {
    package?: {
        name?: string;
        ecosystem?: string;
    };
    ranges?: OsvRange[];
    versions?: string[];
}
export interface OsvVuln {
    id: string;
    summary?: string;
    details?: string;
    aliases?: string[];
    affected?: OsvAffected[];
    database_specific?: {
        cwe_ids?: string[];
    };
}
export declare function formatAffectedRange(vuln: OsvVuln): string;
export declare function queryOsv(name: string, version: string, fetchImpl?: typeof fetch): Promise<SourceResult<OsvVuln[]>>;
