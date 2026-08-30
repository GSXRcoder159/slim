import { type SourceResult } from "./status.ts";
export interface NpmLatest {
    version: string;
    time?: string;
    versions?: string[];
}
export declare function npmLatest(name: string, fetchImpl?: typeof fetch): Promise<SourceResult<NpmLatest>>;
