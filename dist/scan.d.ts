import { existsSync } from "node:fs";
import { relative } from "node:path";
import type { CliArgs } from "./cli.ts";
import { EXIT_USAGE } from "./exit.ts";
import type { Envelope } from "./envelope/types.ts";
export declare const SCAN_SCHEMA_VERSION: 2;
export type VersionState = "exact" | "range-only" | "malformed" | "unavailable";
export type ScanRelation = "declared-imported" | "declared-unused" | "imported-undeclared";
export type DeclaredAs = "dependency" | "optional" | "peer" | "dev" | "none";
export type ScanVerdict = "candidate" | "review" | "refuse" | "unused";
export type SizeProvenance = "measured" | "estimated" | "unknown" | "partial";
export type SizeState = "measured" | "estimated" | "unknown" | "refused" | "review";
export interface ScanRow {
    name: string;
    family: string;
    subpaths: string[];
    importSites: number;
    typeOnlySites: number;
    version: string;
    versionState: VersionState;
    versionReason: string;
    relation: ScanRelation;
    declaredAs: DeclaredAs;
    verdict: ScanVerdict;
    slimmable: number;
    minBytes: number | null;
    gzipBytes: number | null;
    sizeProvenance: SizeProvenance;
    sizeState: SizeState;
    note: string;
}
export interface ScanReport {
    schemaVersion: typeof SCAN_SCHEMA_VERSION;
    lockfile: string | null;
    rows: ScanRow[];
}
export declare function scanProject(cwd?: string): ScanReport;
export declare function scanReportJson(report: ScanReport): string;
export declare function formatScanHuman(report: ScanReport): string;
export declare function runScan(args: CliArgs): Promise<number>;
export declare function writeEnvelope(root: string, pkg: string, env: Envelope): string;
export { existsSync, relative, EXIT_USAGE };
