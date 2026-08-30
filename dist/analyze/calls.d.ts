import type ts from "typescript";
import type { CallSite, UnknownSite } from "../envelope/types.ts";
import type { Binding, CollectExtra } from "./model.ts";
export declare function walkUses(ts: typeof import("typescript"), sf: ts.SourceFile, bindings: Binding[], wanted: Set<string> | null, callSites: CallSite[], unknowns: UnknownSite[], resultMembers: Map<string, Set<string>>, extra: CollectExtra, checker?: ts.TypeChecker): void;
