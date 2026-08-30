import type { Envelope, SourceLoc, TraceEvent } from "../envelope/types.ts";
export declare function attributeTraces(env: Envelope, traces: TraceEvent[], root: string): TraceEvent[];
export declare function symbolMatches(exportName: string, symbol: string): boolean;
export declare function locMatch(site: {
    file: string;
    line: number;
}, loc: SourceLoc, root: string): boolean;
