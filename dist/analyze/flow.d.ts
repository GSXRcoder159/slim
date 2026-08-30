import type ts from "typescript";
import type { UnknownSite } from "../envelope/types.ts";
import type { Binding, CollectExtra } from "./model.ts";
export declare function unwrapDeep(ts: typeof import("typescript"), expr: ts.Expression): ts.Expression;
export declare function isDynamicCodeCallee(ts: typeof import("typescript"), expr: ts.Expression, aliases: Map<string, "eval" | "Function">): "eval" | "Function" | null;
export declare function bindingFromExpr(ts: typeof import("typescript"), expr: ts.Expression, localSet: Map<string, Binding>): Binding | null;
export declare function bindPatternOrIdent(ts: typeof import("typescript"), name: ts.BindingName, initializer: ts.Expression | undefined, localSet: Map<string, Binding>, bindings: Binding[] | null): void;
/** File-level aliases and `export { local }` hops, before bindLocalReexports. */
export declare function collectFileAliases(ts: typeof import("typescript"), sf: ts.SourceFile, bindings: Binding[], extra: CollectExtra): void;
export declare function pushUnknown(ts: typeof import("typescript"), sf: ts.SourceFile, node: ts.Node, extra: CollectExtra, unknowns: UnknownSite[], kind: UnknownSite["kind"], detail: string, widensTo: UnknownSite["widensTo"], prefix: string): void;
export declare function identifierValueEscape(ts: typeof import("typescript"), ident: ts.Identifier, localSet: Map<string, Binding>): Binding | null;
