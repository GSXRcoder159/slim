import type { TraceEvent } from "../envelope/types.ts";
import { extractEsmExportNames } from "./esm-names.ts";
import { matchesTracedUrl, packageFromUrl } from "./match.ts";
export { extractEsmExportNames, matchesTracedUrl, packageFromUrl };
export declare function createSlimHooks(opts: {
    packages: string[];
    outPath?: string;
}): {
    register(): void;
    events(): TraceEvent[];
    flush(): void;
};
