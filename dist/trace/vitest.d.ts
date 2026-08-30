import { wrapExports } from "./proxy.ts";
export { wrapExports };
/** Source for `.slim/vitest.trace.ts` used only for the TRACE run. */
export type VitestTraceConfigOpts = {
    userConfigSpecifier?: string | null;
    alreadyHasPlugin?: boolean;
};
export declare function vitestTraceConfigSource(packages: string[], pluginSpecifier: string, opts?: VitestTraceConfigOpts): string;
export type SlimVitestPlugin = {
    name: "slim-vitest";
    enforce?: "pre";
    config?: (...args: unknown[]) => unknown;
    transform?: (code: string, id: string) => unknown;
    resolveId?: (id: string, importer?: string) => unknown;
    load?: (id: string) => unknown;
};
export declare function slimWrapperSource(id: string, packageName: string, names?: string[]): string;
export declare function slimVitest(opts?: {
    packages?: string[];
}): SlimVitestPlugin;
export default slimVitest;
