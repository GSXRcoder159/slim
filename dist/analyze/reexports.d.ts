import type ts from "typescript";
import type { ImportSite } from "../envelope/types.ts";
import type { Binding, CollectExtra } from "./model.ts";
export declare function wantedSpecifiers(pkg: string): Set<string> | null;
export declare function specifierMatches(specifier: string, wanted: Set<string> | null): boolean;
export declare function collectImports(ts: typeof import("typescript"), sf: ts.SourceFile, bindings: Binding[], imports: ImportSite[], wanted: Set<string> | null, extra: CollectExtra): void;
export declare function localFromImportCall(ts: typeof import("typescript"), node: ts.CallExpression | ts.NewExpression): string | null;
