import type ts from "typescript";
import type { ImportKind, ImportSite, SourceLoc, UnknownSite } from "../envelope/types.ts";
export interface Binding {
    local: string;
    imported: string;
    specifier: string;
    kind: ImportKind;
    loc: SourceLoc;
}
export interface ProgramCtx {
    program: ts.Program;
    checker: ts.TypeChecker;
    options: ts.CompilerOptions;
    host: ts.CompilerHost;
}
export interface LocalPending {
    loc: SourceLoc;
    consumerFile: string;
    resolvedFile: string;
    names: Array<{
        local: string;
        imported: string;
    }>;
    namespaceLocal?: string;
    defaultLocal?: string;
}
export interface PkgLink {
    file: string;
    specifier: string;
    names: Map<string, string> | "*";
}
export interface LocalHop {
    file: string;
    specifier: string;
}
export interface CollectExtra {
    localPending: LocalPending[];
    pkgLinks: PkgLink[];
    localHops: LocalHop[];
    programCtx: ProgramCtx | null;
    root: string;
    typeOnly: ImportSite[];
    unknowns: UnknownSite[];
    wanted: Set<string> | null;
}
export declare function scriptKind(ts: typeof import("typescript"), file: string): ts.ScriptKind;
export declare function locOf(sf: ts.SourceFile, node: ts.Node, root: string): SourceLoc;
export declare function uid(prefix: string, sf: ts.SourceFile, node: ts.Node, root: string): string;
export declare function toProjectRel(file: string, root: string): string;
export declare function normPath(p: string): string;
export declare function exportNameOf(b: Binding): string;
export declare function resolveRelative(fromFile: string, spec: string): string | null;
