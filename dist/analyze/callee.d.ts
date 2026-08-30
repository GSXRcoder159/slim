import type ts from "typescript";
import type { ThisBinding, CallSite } from "../envelope/types.ts";
import type { Binding } from "./model.ts";
export declare function unwrapExpr(ts: typeof import("typescript"), expr: ts.Expression): ts.Expression;
export declare function resolveCallee(ts: typeof import("typescript"), expr: ts.Expression, localSet: Map<string, Binding>, wanted: Set<string> | null): {
    exportName: string;
    memberPath: string[];
    dynamic: boolean;
} | null;
export declare function peelCallApplyBind(ts: typeof import("typescript"), expr: ts.Expression, localSet: Map<string, Binding>, wanted: Set<string> | null): {
    callee: ts.Expression;
    thisKind: ThisBinding | null;
};
export declare function thisOf(ts: typeof import("typescript"), expr: ts.Expression): ThisBinding;
export declare function asBindingEscape(ts: typeof import("typescript"), arg: ts.Expression, localSet: Map<string, Binding>): {
    name: string;
    namespace: boolean;
} | null;
export declare function namespaceIdent(ts: typeof import("typescript"), expr: ts.Expression, localSet: Map<string, Binding>): Binding | null;
export declare function originCallSite(ts: typeof import("typescript"), expr: ts.Expression, lookupIdent: (name: string) => CallSite | undefined, callByNode: WeakMap<ts.Node, CallSite>): CallSite | undefined;
