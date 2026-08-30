import { readFileSync } from "node:fs";
export type SpecSource = "bundled-dts" | "types-package" | "subpath-dts" | "readme" | "envelope-only";
export interface PublicApiSpec {
    text: string;
    source: SpecSource;
    from?: string;
    limitation?: string;
}
export declare function loadPublicApi(projectRoot: string, pkg: string, subpath?: string): PublicApiSpec;
export { readFileSync };
