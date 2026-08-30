import type { TraceEvent } from "../envelope/types.ts";
import type { TraceErrorRecord } from "./session.ts";
export interface WrapOpts {
    packageName: string;
    onEvent: (e: TraceEvent) => void;
    onError?: (e: TraceErrorRecord) => void;
}
export declare function wrapExports(exports: unknown, opts: WrapOpts): unknown;
