import type { Project } from "../project.ts";
import type { Envelope, ImportSite } from "../envelope/types.ts";
export interface AnalyzeOptions {
    allowUnknown?: boolean;
    ignore?: string[];
    include?: string[];
}
export declare function analyzePackage(project: Project, pkg: string, opts?: AnalyzeOptions): Envelope;
export declare function collectPackageSpecifiers(project: Project, opts?: {
    include?: string[];
    ignore?: string[];
}): {
    runtime: Map<string, ImportSite[]>;
    typeOnly: Map<string, ImportSite[]>;
};
export declare function collectImportSpecifiers(project: Project, opts?: {
    include?: string[];
    ignore?: string[];
}): Map<string, ImportSite[]>;
