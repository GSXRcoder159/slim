import type ts from "typescript";
import type { ArgShape, CallSite } from "../envelope/types.ts";
export declare function shapeOf(ts: typeof import("typescript"), node: ts.Expression, checker?: ts.TypeChecker): ArgShape;
export declare function argShapeUnresolved(shape: ArgShape): boolean;
export declare function inferHyrum(exportName: string, sites: CallSite[]): import("../envelope/types.ts").HyrumFlags;
export declare function argIsTsAny(ts: typeof import("typescript"), node: ts.Expression, checker?: ts.TypeChecker): boolean;
